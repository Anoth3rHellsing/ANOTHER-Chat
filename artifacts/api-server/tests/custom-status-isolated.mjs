// Isolated regression coverage for PATCH /users/me custom status and emoji.
// Reproduces the broken raw-SQL interpolation (custom_status=1 instead of $1)
// and validates Zod bounds, null handling, and persisted response shape.
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

const testDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(apiRoot, "../..");
const databaseRoot = path.join(repoRoot, "lib/db");
const apiRequire = createRequire(path.join(apiRoot, "package.json"));
const { build } = apiRequire("esbuild");
const esbuildPluginPino = apiRequire("esbuild-plugin-pino");

let tempRoot;
let pgBin;
let pgData;
let pgPort;
let apiPort;
let databaseName;
let apiProcess;
let apiExit;
let pgStarted = false;

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
  try {
    candidates.push(...readdirSync("/nix/store")
      .filter(name => /^.+-postgresql-16(?:\..+)?$/.test(name))
      .map(name => path.join("/nix/store", name, "bin")));
  } catch {}
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

function isolatedEnvironment(databaseUrl, port) {
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

function sql(statement, env, tuplesOnly = false) {
  const args = [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", os.userInfo().username,
    "-d", databaseName, "-X", "-q",
  ];
  if (tuplesOnly) args.push("-t", "-A");
  args.push("-v", "ON_ERROR_STOP=1", "-c", statement);
  return run(path.join(pgBin, "psql"), args, { env }).trim();
}

function account(base) {
  const cookies = new Map();
  return {
    cookies,
    async request(url, {
      method = "GET",
      json,
      csrf = "auto",
      cookieHeader,
      headers: extraHeaders = {},
    } = {}) {
      const headers = { ...extraHeaders };
      if (cookieHeader !== undefined) {
        headers.Cookie = cookieHeader;
      } else if (cookies.size) {
        headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      }
      if (csrf === "auto" && cookies.has("csrf_token") && method !== "GET" && method !== "HEAD") {
        headers["x-csrf-token"] = cookies.get("csrf_token");
      } else if (csrf === "wrong") {
        headers["x-csrf-token"] = "not-the-session-token";
      } else if (csrf === "valid") {
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

function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.result)}`);
  console.log(`PASS ${label} (${status})`);
  return response.result;
}

async function buildApiIntoTemp() {
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
  });
  return path.join(outDir, "index.mjs");
}

async function cleanup() {
  if (apiProcess && apiProcess.exitCode === null && apiProcess.signalCode === null) {
    apiProcess.kill("SIGTERM");
    await Promise.race([apiExit, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (apiProcess.exitCode === null && apiProcess.signalCode === null) {
      apiProcess.kill("SIGKILL");
      await apiExit;
    }
  }
  if (pgStarted) {
    run(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"]);
    pgStarted = false;
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

try {
  const tmpDir = os.tmpdir();
  const isPosixTmp = tmpDir === "/tmp";
  const isWinTmp = process.platform === "win32" && /^[A-Z]:\\/.test(tmpDir);
  assert.ok(isPosixTmp || isWinTmp, `this test requires disposable data under /tmp or Windows user temp, got ${tmpDir}`);
  pgBin = postgresBinDirectory();
  assert.ok(pgBin, "PostgreSQL 16 tools are required");
  const postgresVersion = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(postgresVersion, /PostgreSQL\) 16\b/, `Expected PostgreSQL 16, got ${postgresVersion.trim()}`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "custom-status-isolated-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await freePort();
  apiPort = await freePort();
  const pgUser = os.userInfo().username;
  databaseName = `custom_status_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${databaseName}`;
  const env = isolatedEnvironment(databaseUrl, apiPort);

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
    cwd: databaseRoot,
    env,
    encoding: "utf8",
  });
  if (migration.error || migration.status !== 0) {
    throw new Error(`Full versioned migrations against empty PostgreSQL 16 failed (${migration.error?.message ?? `exit ${migration.status}`})\n${migration.stdout ?? ""}\n${migration.stderr ?? ""}`);
  }
  console.log("PASS full versioned migrations applied to a fresh disposable PostgreSQL 16 database");

  const bundle = await buildApiIntoTemp();
  const apiCwd = path.join(tempRoot, "api");
  await mkdir(path.join(apiCwd, "uploads"), { recursive: true });
  const base = `http://127.0.0.1:${apiPort}`;
  apiProcess = spawn(process.execPath, [bundle], { cwd: apiCwd, env, stdio: "ignore" });
  apiExit = once(apiProcess, "exit");
  const readyUntil = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < readyUntil) {
    if (apiProcess.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      if ((await fetch(`${base}/api/auth/me`)).status === 401) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  assert.ok(ready, "isolated API responds unauthenticated after readiness polling");
  console.log("PASS isolated API runs with its own uploads directory, database, and PostgreSQL sessions");

  // Register admin (first account) and a non-admin member for testing.
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminPassword = `Disposable-${randomUUID()}!`;
  const admin = account(base);
  const adminAccount = expectStatus(await admin.request("/api/auth/register", {
    method: "POST",
    json: { username: `cs_admin_${suffix}`, password: adminPassword, displayName: "Custom status admin" },
  }), 201, "register the first account (admin)");
  assert.equal(adminAccount.role, "admin");

  const invite = expectStatus(await admin.request("/api/admin/invites", {
    method: "POST", json: {},
  }), 201, "create an invite for the non-admin member");

  const member = account(base);
  const memberPassword = `Disposable-${randomUUID()}!`;
  const memberAccount = expectStatus(await member.request("/api/auth/register", {
    method: "POST",
    json: { username: `cs_member_${suffix}`, password: memberPassword, displayName: "Custom status member", inviteCode: invite.code },
  }), 201, "register a non-admin member with invite");
  assert.equal(memberAccount.role, "member");
  assert.notEqual(memberAccount.id, adminAccount.id, "member id must differ from admin id");

  // --- Test cases for PATCH /users/me custom status ---

  // 1. Valid custom status and emoji persist and return 200
  const validStatus = expectStatus(await member.request("/api/users/me", {
    method: "PATCH",
    json: { customStatus: "Trabajando en algo", statusEmoji: "🔧" },
  }), 200, "set valid custom status and emoji returns 200");
  assert.equal(validStatus.customStatus, "Trabajando en algo", "response includes persisted customStatus");
  assert.equal(validStatus.statusEmoji, "🔧", "response includes persisted statusEmoji");

  // Verify persistence in database directly
  const dbRow = sql(
    `SELECT custom_status, status_emoji FROM users WHERE id = ${memberAccount.id}`,
    env,
    true,
  );
  const [dbCustomStatus, dbStatusEmoji] = dbRow.split("|");
  assert.equal(dbCustomStatus, "Trabajando en algo", "custom_status persisted correctly in database");
  assert.equal(dbStatusEmoji, "🔧", "status_emoji persisted correctly in database");
  console.log("PASS valid custom status and emoji persist to database and are returned in response");

  // 2. customStatus over 128 chars returns 400
  const longStatus = "a".repeat(129);
  expectStatus(await member.request("/api/users/me", {
    method: "PATCH",
    json: { customStatus: longStatus },
  }), 400, "customStatus exceeding 128 characters returns 400");

  // 3. statusEmoji over 20 chars returns 400 (not 500 from broken SQL)
  const longEmoji = "😀".repeat(21);
  expectStatus(await member.request("/api/users/me", {
    method: "PATCH",
    json: { statusEmoji: longEmoji },
  }), 400, "statusEmoji exceeding 20 characters returns 400 not 500");

  // 4. Invalid status value returns 400
  expectStatus(await member.request("/api/users/me", {
    method: "PATCH",
    json: { status: "invisible" },
  }), 400, "invalid status value returns 400");

  // 5. Null values clear the fields
  const cleared = expectStatus(await member.request("/api/users/me", {
    method: "PATCH",
    json: { customStatus: null, statusEmoji: null },
  }), 200, "null customStatus and statusEmoji clears both fields");
  assert.equal(cleared.customStatus, null, "customStatus is null after clearing");
  assert.equal(cleared.statusEmoji, null, "statusEmoji is null after clearing");

  // 6. Response reflects what was saved, not just what was sent
  const roundTrip = expectStatus(await member.request("/api/users/me", {
    method: "PATCH",
    json: { customStatus: "En reunión", statusEmoji: "📅", status: "dnd" },
  }), 200, "patch with status, customStatus and emoji returns saved row");
  assert.equal(roundTrip.customStatus, "En reunión", "response customStatus matches saved value");
  assert.equal(roundTrip.statusEmoji, "📅", "response statusEmoji matches saved value");
  assert.equal(roundTrip.status, "dnd", "response status matches saved value");

  console.log("PASS all custom status validation and persistence checks passed");
} finally {
  await cleanup();
}