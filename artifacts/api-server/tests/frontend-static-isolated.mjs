// Isolated regression coverage for serving the compiled frontend from the API
// process (FRONTEND_DIST_DIR), used by single-container deployments (Coolify).
// Guarantees: /api and /ws are never shadowed, user uploads are never exposed as
// static files, client routes fall back to index.html, missing assets stay 404,
// the document keeps a Referer-friendly policy (YouTube embeds), and nothing is
// mounted when FRONTEND_DIST_DIR is unset (Replit keeps serving the frontend).
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
let pgStarted = false;
const apiProcesses = [];

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

function isolatedEnvironment(databaseUrl, port, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete env[key];
    }
    if (/^GIPHY/i.test(key)) delete env[key];
  }
  delete env.Giphy;
  delete env.FRONTEND_DIST_DIR;
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    MESSAGE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    NODE_ENV: "development",
    LOG_LEVEL: "fatal",
    PORT: String(port),
    APP_URL: `http://127.0.0.1:${port}`,
    ...extra,
  };
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

async function startApi(bundle, cwd, env) {
  const child = spawn(process.execPath, [bundle], { cwd, env, stdio: "ignore" });
  const exited = once(child, "exit");
  apiProcesses.push({ child, exited });
  const base = `http://127.0.0.1:${env.PORT}`;
  const readyUntil = Date.now() + 20_000;
  while (Date.now() < readyUntil) {
    if (child.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      if ((await fetch(`${base}/api/auth/me`)).status === 401) return base;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error("Isolated API did not become ready");
}

async function get(base, url, headers = { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" }) {
  const response = await fetch(base + url, { headers, redirect: "manual" });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function cleanup() {
  for (const { child, exited } of apiProcesses) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
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

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "frontend-static-isolated-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await freePort();
  const pgUser = os.userInfo().username;
  const databaseName = `frontend_static_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${databaseName}`;
  const baseEnv = isolatedEnvironment(databaseUrl, 1);

  run(path.join(pgBin, "initdb"), [
    "-D", pgData, "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust",
  ], { env: baseEnv });
  run(path.join(pgBin, "pg_ctl"), [
    "-D", pgData, "-l", path.join(tempRoot, "postgres.log"),
    "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${tempRoot}`,
    "-w", "start",
  ], { env: baseEnv });
  pgStarted = true;
  run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, databaseName], { env: baseEnv });

  const migration = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"], {
    cwd: databaseRoot, env: baseEnv, encoding: "utf8",
  });
  if (migration.error || migration.status !== 0) {
    throw new Error(`Fresh disposable database migrations failed (${migration.error?.message ?? `exit ${migration.status}`})\n${migration.stdout ?? ""}\n${migration.stderr ?? ""}`);
  }
  console.log("PASS full versioned migrations applied to a fresh disposable PostgreSQL 16 database");

  // A synthetic Vite build: index.html, a hashed asset and a root file.
  const marker = `frontend-marker-${randomUUID()}`;
  const distDir = path.join(tempRoot, "frontend", "dist", "public");
  await mkdir(path.join(distDir, "assets"), { recursive: true });
  await writeFile(path.join(distDir, "index.html"), `<!doctype html><html><body>${marker}</body></html>`);
  await writeFile(path.join(distDir, "assets", "index-Ab12Cd34.js"), "console.log('asset');");
  await writeFile(path.join(distDir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  // A secret next to the build and a real user upload: neither may be reachable statically.
  const secret = `outside-dist-${randomUUID()}`;
  await writeFile(path.join(tempRoot, "frontend", "dist", "secret.txt"), secret);

  const bundle = await buildApiIntoTemp();
  const apiCwd = path.join(tempRoot, "api");
  await mkdir(path.join(apiCwd, "uploads"), { recursive: true });
  const uploadSecret = `upload-${randomUUID()}`;
  await writeFile(path.join(apiCwd, "uploads", "private-avatar.png"), uploadSecret);

  const apiPort = await freePort();
  const base = await startApi(bundle, apiCwd, isolatedEnvironment(databaseUrl, apiPort, { FRONTEND_DIST_DIR: distDir }));
  console.log("PASS isolated API starts with FRONTEND_DIST_DIR pointing at a compiled frontend");

  // 1. The root document is the compiled index.html, revalidated on every load.
  const root = await get(base, "/");
  assert.equal(root.status, 200, "GET / serves the frontend");
  assert.ok(root.body.includes(marker), "GET / returns the compiled index.html");
  assert.equal(root.headers.get("cache-control"), "no-cache", "index.html is revalidated so deploys take effect");
  assert.equal(root.headers.get("referrer-policy"), "strict-origin-when-cross-origin",
    "the document must send a Referer to embeds (YouTube rejects no-referrer)");
  assert.equal(root.headers.get("x-content-type-options"), "nosniff");
  assert.equal(root.headers.get("set-cookie"), null, "serving the document never creates a session");
  console.log("PASS GET / serves index.html with no-cache and a Referer-friendly policy");

  // 2. Client-side routes fall back to index.html.
  const deepLink = await get(base, "/servers/7/channels/3");
  assert.equal(deepLink.status, 200);
  assert.ok(deepLink.body.includes(marker), "client routes fall back to index.html");
  console.log("PASS client-side routes fall back to index.html");

  // 3. Hashed assets are immutable; missing assets are a real 404, not index.html.
  const asset = await get(base, "/assets/index-Ab12Cd34.js", { Accept: "*/*" });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const favicon = await get(base, "/favicon.svg", { Accept: "*/*" });
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("cache-control"), "no-cache", "unhashed root files are revalidated");
  const missingAsset = await get(base, "/assets/index-Missing.js");
  assert.equal(missingAsset.status, 404, "a missing asset is a 404");
  assert.ok(!missingAsset.body.includes(marker), "a missing asset never returns index.html");
  console.log("PASS hashed assets are immutable and missing assets stay 404");

  // 4. The API is never shadowed by the frontend.
  const me = await get(base, "/api/auth/me");
  assert.equal(me.status, 401, "API routes still answer");
  assert.ok(!me.body.includes(marker));
  const unknownApi = await get(base, "/api/definitely-not-a-route");
  assert.notEqual(unknownApi.status, 200, "unknown API paths are not rewritten to the SPA");
  assert.ok(!unknownApi.body.includes(marker), "unknown API paths never return index.html");
  const bareApi = await get(base, "/api");
  assert.ok(!bareApi.body.includes(marker), "/api itself never returns index.html");
  const wsPath = await get(base, "/ws");
  assert.ok(!wsPath.body.includes(marker), "/ws never returns index.html");
  console.log("PASS /api and /ws are never shadowed by the frontend fallback");

  // 5. User uploads are never static files and still require authorization.
  const staticUpload = await get(base, "/uploads/private-avatar.png", { Accept: "*/*" });
  assert.ok(!staticUpload.body.includes(uploadSecret), "uploads are not reachable as static files");
  const anonymousUpload = await get(base, "/api/uploads/private-avatar.png", { Accept: "*/*" });
  assert.notEqual(anonymousUpload.status, 200, "anonymous upload access is still rejected");
  assert.ok(!anonymousUpload.body.includes(uploadSecret));
  console.log("PASS user uploads are not exposed and still require authorization");

  // 6. No traversal outside the compiled directory.
  for (const attempt of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
    const traversal = await get(base, attempt, { Accept: "*/*" });
    assert.ok(!traversal.body.includes(secret), `no traversal via ${attempt}`);
  }
  console.log("PASS encoded traversal cannot read files outside the compiled frontend");

  // 7. Mutations are not answered with the document.
  const post = await fetch(base + "/", { method: "POST", headers: { Accept: "text/html" } });
  const postBody = await post.text();
  assert.notEqual(post.status, 200, "POST / is not served the frontend");
  assert.ok(!postBody.includes(marker));
  console.log("PASS non-GET requests are never answered with index.html");

  // 8. Without FRONTEND_DIST_DIR nothing is mounted (Replit serves the frontend itself).
  const plainPort = await freePort();
  const plainBase = await startApi(bundle, apiCwd, isolatedEnvironment(databaseUrl, plainPort));
  const plainRoot = await get(plainBase, "/");
  assert.equal(plainRoot.status, 404, "without FRONTEND_DIST_DIR the API does not serve /");
  assert.ok(!plainRoot.body.includes(marker));
  console.log("PASS without FRONTEND_DIST_DIR the API serves no frontend (Replit behaviour unchanged)");

  // 9. A misconfigured FRONTEND_DIST_DIR fails at startup instead of serving 404s.
  const emptyDir = path.join(tempRoot, "empty-dist");
  await mkdir(emptyDir, { recursive: true });
  const brokenPort = await freePort();
  const broken = spawn(process.execPath, [bundle], {
    cwd: apiCwd, env: isolatedEnvironment(databaseUrl, brokenPort, { FRONTEND_DIST_DIR: emptyDir }), stdio: "ignore",
  });
  const brokenExit = once(broken, "exit");
  apiProcesses.push({ child: broken, exited: brokenExit });
  const [exitCode] = await Promise.race([
    brokenExit,
    new Promise((_, reject) => setTimeout(() => reject(new Error("misconfigured API kept running")), 20_000)),
  ]);
  assert.notEqual(exitCode, 0, "startup fails when FRONTEND_DIST_DIR has no index.html");
  console.log("PASS a FRONTEND_DIST_DIR without index.html aborts startup");
} finally {
  await cleanup();
}
