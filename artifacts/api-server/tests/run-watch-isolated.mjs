// Run the Watch Party integration suite against a disposable API and PostgreSQL 16 cluster.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(apiRoot, "../..");
const databaseRoot = path.join(repoRoot, "lib/db");
const apiPort = 4011;
const base = `http://127.0.0.1:${apiPort}`;
const apiRequire = createRequire(path.join(apiRoot, "package.json"));
const { build } = apiRequire("esbuild");
const esbuildPluginPino = apiRequire("esbuild-plugin-pino");

let tempRoot;
let pgBin;
let pgData;
let pgPort;
let pgDatabase;
let pgUser;
let apiProcess;
let apiExit;
let pgStarted = false;
let complete = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} failed (${detail})`);
  }
  return result.stdout ?? "";
}

function postgresBinDirectory() {
  const candidates = [];
  const bindir = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  if (bindir.status === 0) candidates.push(bindir.stdout.trim());
  const initdb = spawnSync("which", ["initdb"], { encoding: "utf8" });
  if (initdb.status === 0) candidates.push(path.dirname(initdb.stdout.trim()));
  try {
    candidates.push(...readdirSync("/nix/store")
      .filter(name => /^.+-postgresql-16(?:\..+)?$/.test(name))
      .map(name => path.join("/nix/store", name, "bin")));
  } catch {}
  return candidates.find(candidate =>
    candidate && ["initdb", "pg_ctl", "createdb", "psql", "postgres"].every(tool =>
      existsSync(path.join(candidate, tool)),
    ),
  );
}

async function reserveFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function assertPortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function isolatedEnvironment(databaseUrl) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "DATABASE_URL" || /^PG[A-Z0-9_]+$/.test(key)) delete env[key];
  }
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    MESSAGE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    NODE_ENV: "development",
    LOG_LEVEL: "fatal",
    PORT: String(apiPort),
    APP_URL: base,
  };
}

async function buildApiIntoTemp() {
  const buildDir = path.join(tempRoot, "api-server");
  const outDir = path.join(buildDir, "dist");
  await mkdir(outDir, { recursive: true });
  await symlink(path.join(apiRoot, "node_modules"), path.join(buildDir, "node_modules"), "dir");
  await build({
    entryPoints: [
      path.join(apiRoot, "src/index.ts"),
      path.join(apiRoot, "src/scripts/migrate-message-encryption.ts"),
    ],
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
    plugins: [
      esbuildPluginPino({ transports: ["pino-pretty"] }),
      {
        name: "bind-disposable-api-to-loopback",
        setup(builder) {
          builder.onLoad({ filter: /[/\\]api-server[/\\]src[/\\]index\.ts$/ }, async args => {
            const source = await readFile(args.path, "utf8");
            const listenCall = "server.listen(port, () => {";
            assert.ok(source.includes(listenCall), "Expected API listen call before loopback-only test transform");
            return {
              contents: source.replace(listenCall, 'server.listen(port, "127.0.0.1", () => {'),
              loader: "ts",
              resolveDir: path.dirname(args.path),
            };
          });
        },
      },
    ],
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

async function pollApiReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      if ((await fetch(`${base}/api/auth/me`)).status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Isolated API did not become ready");
}

async function stopApi() {
  if (!apiProcess || (apiProcess.exitCode !== null && apiProcess.signalCode !== null)) return;
  if (apiProcess.exitCode === null && apiProcess.signalCode === null) {
    apiProcess.kill("SIGTERM");
    await Promise.race([apiExit, new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  if (apiProcess.exitCode === null && apiProcess.signalCode === null) {
    apiProcess.kill("SIGKILL");
    await apiExit;
  }
}

async function cleanup() {
  await stopApi();
  if (pgStarted) {
    if (pgDatabase) {
      run(path.join(pgBin, "dropdb"), [
        "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, pgDatabase,
      ], { env: isolatedEnvironment(`postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${pgDatabase}`) });
      pgDatabase = undefined;
    }
    run(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"]);
    pgStarted = false;
  }
  if (apiProcess) {
    assert.ok(apiProcess.exitCode !== null || apiProcess.signalCode !== null,
      "temporary API process must exit");
    assert.throws(() => process.kill(apiProcess.pid, 0), "temporary API process must no longer exist");
  }
  if (pgData && pgBin) {
    const status = spawnSync(path.join(pgBin, "pg_ctl"), ["-D", pgData, "status"], { encoding: "utf8" });
    assert.notEqual(status.status, 0, "temporary PostgreSQL server must no longer be running");
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  if (tempRoot) assert.equal(existsSync(tempRoot), false, "temporary test files must be removed");
}

try {
  assert.equal(os.tmpdir(), "/tmp", "this test requires disposable files under /tmp");
  await assertPortFree(apiPort);
  pgBin = postgresBinDirectory();
  if (!pgBin) throw new Error("PostgreSQL 16 initdb/pg_ctl/createdb/psql binaries are unavailable");
  const version = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(version, /PostgreSQL\) 16\b/, `Expected PostgreSQL 16, got ${version.trim()}`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "watch-integration-"));
  pgData = path.join(tempRoot, "postgres-data");
  const logPath = path.join(tempRoot, "postgres.log");
  pgPort = await reserveFreePort();
  pgDatabase = `watch_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  pgUser = os.userInfo().username;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${pgDatabase}`;
  const env = isolatedEnvironment(databaseUrl);
  assert.notEqual(databaseUrl, process.env.DATABASE_URL,
    "Disposable database URL must never match inherited DATABASE_URL");
  console.log("PASS inherited DATABASE_URL and PG* connection overrides excluded from all test services");

  run(path.join(pgBin, "initdb"), [
    "-D", pgData, "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust",
  ], { env });
  run(path.join(pgBin, "pg_ctl"), [
    "-D", pgData, "-l", logPath,
    "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${tempRoot}`,
    "-w", "start",
  ], { env });
  pgStarted = true;
  run(path.join(pgBin, "createdb"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, pgDatabase,
  ], { env });
  const migration = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"], {
    cwd: databaseRoot,
    env,
    encoding: "utf8",
  });
  if (migration.error || migration.status !== 0) {
    throw new Error(`Drizzle migration against empty disposable database failed (${migration.error?.message ?? `exit ${migration.status}`})`);
  }
  console.log("PASS full Drizzle migration chain applied to empty temporary PostgreSQL 16 database");

  const bundle = await buildApiIntoTemp();
  apiProcess = spawn(process.execPath, [bundle], {
    cwd: tempRoot,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  apiExit = once(apiProcess, "exit");
  await pollApiReady();
  console.log("PASS current API source bundled under /tmp and serving only on disposable port 4011");

  const test = spawnSync(process.execPath, [path.join(testDir, "watch-isolated.mjs")], {
    cwd: tempRoot,
    env: {
      ...env,
      WATCH_TEST_BASE: base,
    },
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (test.stdout) process.stdout.write(test.stdout);
  if (test.stderr) process.stderr.write(test.stderr);
  if (test.error || test.status !== 0) {
    throw new Error(`watch-isolated.mjs failed (${test.error?.message ?? `exit ${test.status}`})`);
  }
  complete = true;
} finally {
  try {
    await cleanup();
  } catch (error) {
    if (complete) throw error;
    console.error(`CLEANUP FAILURE: ${error.message}`);
    throw error;
  }
}

if (!complete) throw new Error("Disposable watch integration verification did not complete");
console.log("PASS disposable PostgreSQL 16, isolated API process, synthetic accounts, database files, and temp workspace all cleaned up");