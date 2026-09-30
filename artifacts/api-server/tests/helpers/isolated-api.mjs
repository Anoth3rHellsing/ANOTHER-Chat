// Shared harness for isolated regression scenarios: a disposable PostgreSQL 16
// under /tmp, the full versioned migration chain, and the API bundled with
// esbuild and started on a free loopback port. Each scenario gets its own
// database, uploads directory and PostgreSQL sessions; nothing touches the
// development or production databases.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(helpersDir, "../..");
const repoRoot = path.resolve(apiRoot, "../..");
const databaseRoot = path.join(repoRoot, "lib/db");
const apiRequire = createRequire(path.join(apiRoot, "package.json"));
const { build } = apiRequire("esbuild");
const esbuildPluginPino = apiRequire("esbuild-plugin-pino");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} failed (${result.error?.message ?? `exit ${result.status}`})\n${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

function postgresBinDirectory() {
  const candidates = [];
  const configured = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (configured.status === 0) candidates.push(configured.stdout.trim());
  const initdb = spawnSync("which", ["initdb"], { encoding: "utf8" }).stdout?.trim();
  if (initdb) candidates.push(path.dirname(initdb));
  if (existsSync("/nix/store")) {
    candidates.push(...readdirSync("/nix/store")
      .filter(name => /^.+-postgresql-16(?:\..+)?$/.test(name))
      .map(name => path.join("/nix/store", name, "bin")));
  }
  return candidates.find(dir =>
    dir && ["initdb", "pg_ctl", "createdb", "psql", "postgres"].every(binary =>
      existsSync(path.join(dir, binary)),
    ),
  );
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function apiEnvironment(databaseUrl, port) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete env[key];
    }
    if (/^GIPHY/i.test(key)) delete env[key];
  }
  delete env.Giphy;
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    MESSAGE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    NODE_ENV: "development",
    LOG_LEVEL: "fatal",
    PORT: String(port),
    APP_URL: `http://127.0.0.1:${port}`,
  };
}

async function bundleApi(tempRoot) {
  const buildDir = path.join(tempRoot, "api");
  const outDir = path.join(buildDir, "dist");
  await mkdir(outDir, { recursive: true });
  await symlink(path.join(apiRoot, "node_modules"), path.join(buildDir, "node_modules"), "dir");
  await build({
    entryPoints: [path.join(apiRoot, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: outDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
    external: [
      "*.node", "sharp", "better-sqlite3", "sqlite3", "canvas", "bcrypt", "argon2",
      "fsevents", "re2", "farmhash", "xxhash-addon", "bufferutil", "utf-8-validate",
      "ssh2", "cpu-features", "dtrace-provider", "isolated-vm", "lightningcss",
      "pg-native", "oracledb", "mongodb-client-encryption", "nodemailer", "handlebars",
      "knex", "typeorm", "protobufjs", "onnxruntime-node", "@tensorflow/*",
      "@prisma/client", "@mikro-orm/*", "@grpc/*", "@swc/*", "@aws-sdk/*",
      "@azure/*", "@opentelemetry/*", "@google-cloud/*", "@google/*", "googleapis",
      "firebase-admin", "@parcel/watcher", "@sentry/profiling-node", "aws-sdk",
      "classic-level", "dd-trace", "ffi-napi", "grpc", "hiredis", "kerberos",
      "leveldown", "miniflare", "mysql2", "newrelic", "odbc", "piscina", "realm",
      "ref-napi", "rocksdb", "sass-embedded", "sequelize", "serialport", "snappy",
      "tinypool", "usb", "workerd", "wrangler", "zeromq", "zeromq-prebuilt",
      "playwright", "puppeteer", "puppeteer-core", "electron",
    ],
    sourcemap: "linked",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __bannerCrReq } from "node:module";
import __bannerPath from "node:path";
import __bannerUrl from "node:url";
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);`,
    },
    define: { "process.env.NODE_ENV": '"test"' },
  });
  return { bundle: path.join(outDir, "index.mjs"), cwd: buildDir };
}

/** HTTP client with its own cookie jar; sends the CSRF header on writes. */
export function account(base) {
  const cookies = new Map();
  return {
    cookies,
    cookieHeader() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    async request(url, { method = "GET", json, csrf = "auto" } = {}) {
      const headers = {};
      if (cookies.size) headers.Cookie = this.cookieHeader();
      if (csrf === "auto" && cookies.has("csrf_token") && method !== "GET" && method !== "HEAD") {
        headers["x-csrf-token"] = cookies.get("csrf_token");
      }
      if (json !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(base + url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
      });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const offset = pair.indexOf("=");
        if (offset > 0) cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
      }
      const raw = await response.text();
      let result;
      try { result = JSON.parse(raw); } catch { result = raw; }
      return { status: response.status, result, headers: response.headers };
    },
  };
}

export function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    const detail = response.result?.error ?? JSON.stringify(response.result);
    throw new Error(`${label}: expected ${expected}, got ${response.status} — ${detail}`);
  }
  return response.result;
}

/**
 * Starts PostgreSQL, applies every migration and launches the API.
 * Returns { base, sql, stop, logs }. Always call stop() in a finally block.
 */
export async function startIsolatedApi(prefix) {
  assert.ok(os.tmpdir() === "/tmp", `isolated scenarios require /tmp, got ${os.tmpdir()}`);
  const pgBin = postgresBinDirectory();
  assert.ok(pgBin, "PostgreSQL 16 tools are required");
  assert.match(run(path.join(pgBin, "postgres"), ["--version"]), /PostgreSQL\) 16\b/, "PostgreSQL 16 is required");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const pgData = path.join(tempRoot, "postgres-data");
  const pgPort = await freePort();
  const apiPort = await freePort();
  const pgUser = os.userInfo().username;
  const databaseName = `${prefix.replace(/\W/g, "_")}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${databaseName}`;
  const env = apiEnvironment(databaseUrl, apiPort);
  let pgStarted = false;
  let apiProcess;
  let apiExit;
  let logs = "";

  async function stop() {
    if (apiProcess && apiProcess.exitCode === null && apiProcess.signalCode === null) {
      apiProcess.kill("SIGKILL");
      await apiExit.catch(() => {});
    }
    if (pgStarted) {
      try { run(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"]); } catch {}
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }

  function sql(query) {
    const result = spawnSync(path.join(pgBin, "psql"), [
      "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser,
      "-d", databaseName, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", query,
    ], { encoding: "utf8", env });
    if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
    return (result.stdout ?? "").split("\n").filter(Boolean);
  }

  try {
    run(path.join(pgBin, "initdb"), [
      "-D", pgData, "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust",
    ], { env });
    run(path.join(pgBin, "pg_ctl"), [
      "-D", pgData, "-l", path.join(tempRoot, "postgres.log"),
      "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${tempRoot}`,
      "-w", "start",
    ], { env });
    pgStarted = true;
    run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, databaseName], { env });

    const migration = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"], {
      cwd: databaseRoot, env, encoding: "utf8",
    });
    if (migration.error || migration.status !== 0) {
      throw new Error(`Migrations failed\n${migration.stdout ?? ""}\n${migration.stderr ?? ""}`);
    }
    console.log("PASS full versioned migrations applied to a fresh disposable PostgreSQL 16 database");

    const { bundle, cwd } = await bundleApi(tempRoot);
    await mkdir(path.join(cwd, "uploads"), { recursive: true });
    await mkdir(path.join(cwd, "private-channel-files"), { recursive: true });
    const base = `http://127.0.0.1:${apiPort}`;
    apiProcess = spawn(process.execPath, [bundle], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    apiProcess.stderr.on("data", chunk => { logs += chunk.toString(); });
    apiProcess.stdout.on("data", chunk => { logs += chunk.toString(); });
    apiExit = once(apiProcess, "exit");

    const readyUntil = Date.now() + 20_000;
    let ready = false;
    while (Date.now() < readyUntil) {
      if (apiProcess.exitCode !== null) {
        throw new Error(`Isolated API exited before readiness (code ${apiProcess.exitCode})\n${logs.slice(-3000)}`);
      }
      try {
        if ((await fetch(`${base}/api/auth/me`)).status === 401) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 125));
    }
    assert.ok(ready, "isolated API responds unauthenticated after readiness polling");
    console.log("PASS isolated API runs with its own database, uploads directory and sessions");
    return { base, sql, stop, logs: () => logs };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Registers the first account (global admin) and non-admin members joined
 * through admin invites. Returns { admin, adminUser, members: [{ client, user, password }] }.
 */
export async function registerAdminAndMembers(base, prefix, count) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = account(base);
  const adminUser = expectStatus(await admin.request("/api/auth/register", {
    method: "POST",
    json: { username: `${prefix}_admin_${suffix}`, password: `Disposable-${randomUUID()}!`, displayName: "Admin" },
  }), 201, "register the first account (admin)");
  assert.equal(adminUser.role, "admin");

  const members = [];
  for (let index = 0; index < count; index += 1) {
    const invite = expectStatus(await admin.request("/api/admin/invites", { method: "POST", json: {} }), 201, "create an invite");
    const client = account(base);
    const password = `Disposable-${randomUUID()}!`;
    const user = expectStatus(await client.request("/api/auth/register", {
      method: "POST",
      json: {
        username: `${prefix}_m${index}_${suffix}`,
        password,
        displayName: `Miembro ${index}`,
        inviteCode: invite.code,
      },
    }), 201, `register non-admin member ${index}`);
    assert.equal(user.role, "member");
    members.push({ client, user, password });
  }
  return { admin, adminUser, members };
}
