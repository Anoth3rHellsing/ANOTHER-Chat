// Minimal isolated VirusTotal scan roundtrip. PostgreSQL, API runtime, file
// bytes, and the fail-closed VirusTotal mock are disposable under /tmp.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
let database;
let pgUser;
let dbEnv;
let apiPort;
let apiBase;
let bundle;
let mockLogPath;
let apiProcess;
let pgStarted = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? `exit ${result.status}`;
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} failed (${detail})\n${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

function postgresBinDirectory() {
  const candidates = [];
  try {
    const bindir = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
    if (bindir.status === 0) candidates.push(bindir.stdout.trim());
  } catch {}
  candidates.push(path.dirname(spawnSync("which", ["initdb"], { encoding: "utf8" }).stdout?.trim() ?? ""));
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

function isolatedEnvironment(databaseUrl, port, base, extras = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete env[key];
    }
  }
  delete env.VIRUSTOTAL_API_KEY;
  delete env.VirusTotal_Key;
  return {
    ...env,
    ...extras,
    DATABASE_URL: databaseUrl,
    MESSAGE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    NODE_ENV: "development",
    LOG_LEVEL: "fatal",
    PORT: String(port),
    APP_URL: base,
  };
}

function account(base) {
  const cookies = new Map();
  function headers(method, provided = {}) {
    const result = { ...provided };
    if (cookies.size) result.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (cookies.has("csrf_token") && method !== "GET" && method !== "HEAD") {
      result["x-csrf-token"] = cookies.get("csrf_token");
    }
    return result;
  }
  return {
    async request(url, { method = "GET", json, body, headers: provided = {} } = {}) {
      const requestHeaders = headers(method, provided);
      let requestBody = body;
      if (json !== undefined) {
        requestHeaders["Content-Type"] = "application/json";
        requestBody = JSON.stringify(json);
      }
      const response = await fetch(base + url, { method, headers: requestHeaders, body: requestBody });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const offset = pair.indexOf("=");
        if (offset > 0) cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
      }
      const raw = await response.text();
      let result;
      try { result = JSON.parse(raw); } catch { result = raw; }
      return { status: response.status, result };
    },
  };
}

function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.result)}`);
  console.log(`PASS ${label} (${status})`);
  return response.result;
}

function parseId(object, field, label) {
  const value = object?.[field];
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

async function pollApiReady(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      const response = await fetch(`${apiBase}/api/auth/me`);
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Isolated API did not become ready");
}

async function buildApiIntoTemp() {
  const buildDir = path.join(tempRoot, "api-build");
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function syntheticZip(comment) {
  const filename = Buffer.from("README.txt");
  const contents = Buffer.from("harmless isolated VirusTotal smoke fixture");
  const zipComment = Buffer.from(comment);
  const checksum = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const localEntry = Buffer.concat([local, filename, contents]);
  const centralEntry = Buffer.concat([central, filename]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralEntry.length, 12);
  end.writeUInt32LE(localEntry.length, 16);
  end.writeUInt16LE(zipComment.length, 20);
  return Buffer.concat([localEntry, centralEntry, end, zipComment]);
}

async function uploadSyntheticZip(client, channelId, bytes) {
  const initialized = expectStatus(await client.request(`/api/channels/${channelId}/files/uploads`, {
    method: "POST", json: { filename: "virus-total-smoke.zip", sizeBytes: bytes.length },
  }), 201, "initialize synthetic ZIP upload");
  const form = new FormData();
  form.append("chunk", new Blob([bytes], { type: "application/octet-stream" }), "chunk.bin");
  const chunk = expectStatus(await client.request(
    `/api/channels/${channelId}/files/uploads/${initialized.uploadId}/chunks?offset=0`,
    { method: "POST", body: form },
  ), 200, "upload synthetic ZIP bytes");
  assert.equal(chunk.offset, bytes.length);
  assert.equal(chunk.complete, true);
  return expectStatus(await client.request(
    `/api/channels/${channelId}/files/uploads/${initialized.uploadId}/finish`,
    { method: "POST" },
  ), 201, "finish synthetic ZIP upload");
}

async function mockCalls() {
  const raw = await readFile(mockLogPath, "utf8");
  return raw.trim() ? raw.trim().split("\n").map(line => JSON.parse(line)) : [];
}

async function waitForScan(client, channelId, fileId) {
  const deadline = Date.now() + 12_000;
  let scan;
  while (Date.now() < deadline) {
    const response = await client.request(`/api/channels/${channelId}/files/${fileId}/scan`);
    assert.equal(response.status, 200, `scan detail endpoint: ${JSON.stringify(response.result)}`);
    scan = response.result;
    if (scan.status === "completed") return scan;
    if (scan.status === "error") throw new Error(`Mock VirusTotal scan failed: ${JSON.stringify(scan)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Mock VirusTotal scan did not complete: ${JSON.stringify(scan)}`);
}

async function cleanup() {
  if (apiProcess && apiProcess.exitCode === null && apiProcess.signalCode === null) {
    apiProcess.kill("SIGTERM");
    await Promise.race([once(apiProcess, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (apiProcess.exitCode === null && apiProcess.signalCode === null) {
      apiProcess.kill("SIGKILL");
      await once(apiProcess, "exit");
    }
  }
  if (pgStarted) {
    run(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"]);
    pgStarted = false;
  }
  if (apiProcess) {
    assert.ok(apiProcess.exitCode !== null || apiProcess.signalCode !== null, "temporary API process must exit");
    assert.throws(() => process.kill(apiProcess.pid, 0), "temporary API process must no longer exist");
  }
  if (pgData && pgBin) {
    const status = spawnSync(path.join(pgBin, "pg_ctl"), ["-D", pgData, "status"], { encoding: "utf8" });
    assert.notEqual(status.status, 0, "temporary PostgreSQL server must no longer be running");
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

try {
  assert.equal(os.tmpdir(), "/tmp", "this test requires temporary data under /tmp");
  assert.equal(process.env.RUN_LIVE_VT, "0", "live VirusTotal mode must remain disabled");
  pgBin = postgresBinDirectory();
  if (!pgBin) throw new Error("PostgreSQL 16 initdb/pg_ctl/createdb/psql binaries are unavailable");
  const version = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(version, /PostgreSQL\) 16\b/, `Expected PostgreSQL 16, got ${version.trim()}`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "vt-smoke-isolated-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await reserveFreePort();
  apiPort = await reserveFreePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  database = `vt_smoke_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  pgUser = os.userInfo().username;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${database}`;
  dbEnv = isolatedEnvironment(databaseUrl, apiPort, apiBase);

  run(path.join(pgBin, "initdb"), [
    "-D", pgData, "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust",
  ], { env: dbEnv });
  run(path.join(pgBin, "pg_ctl"), [
    "-D", pgData, "-l", path.join(tempRoot, "postgres.log"),
    "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${tempRoot}`,
    "-w", "start",
  ], { env: dbEnv });
  pgStarted = true;
  run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, database], { env: dbEnv });

  const migration = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"], {
    cwd: databaseRoot, env: dbEnv, encoding: "utf8",
  });
  if (migration.error || migration.status !== 0) {
    throw new Error(`Full versioned Drizzle migration chain failed (${migration.error?.message ?? `exit ${migration.status}`})\n${migration.stderr ?? ""}`);
  }
  console.log("PASS full versioned Drizzle migrations on disposable PostgreSQL 16");

  mockLogPath = path.join(tempRoot, "vt-mock-calls.jsonl");
  await writeFile(mockLogPath, "");
  const mockModule = `
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const originalFetch = globalThis.fetch.bind(globalThis);
const logFile = process.env.VT_MOCK_LOG;
let analysisNumber = 0;
const analyses = new Map();
const reply = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const isVirusTotal = url.hostname === "virustotal.com" || url.hostname.endsWith(".virustotal.com");
  if (!isVirusTotal) return originalFetch(input, init);
  const method = init.method ?? (typeof input === "object" ? input.method : undefined) ?? "GET";
  const pathname = url.pathname;
  if (method === "GET" && /^\\/api\\/v3\\/files\\/[a-f0-9]{64}$/.test(pathname)) {
    appendFileSync(logFile, JSON.stringify({ method, pathname }) + "\\n");
    return reply(404, { error: { message: "Synthetic hash miss" } });
  }
  if (method === "POST" && url.hostname === "www.virustotal.com" && pathname === "/api/v3/files") {
    const file = init.body?.get?.("file");
    const bytes = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
    const id = "isolated-analysis-" + (++analysisNumber);
    analyses.set(id, true);
    appendFileSync(logFile, JSON.stringify({
      method, pathname, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    }) + "\\n");
    return reply(200, { data: { id } });
  }
  if (method === "GET" && pathname.startsWith("/api/v3/analyses/")) {
    const id = decodeURIComponent(pathname.slice("/api/v3/analyses/".length));
    if (!analyses.has(id)) throw new Error("Unknown isolated mock analysis " + id);
    appendFileSync(logFile, JSON.stringify({ method, pathname, state: "completed" }) + "\\n");
    return reply(200, { data: { attributes: { status: "completed", stats: {
      harmless: 72, undetected: 11, suspicious: 1, malicious: 0,
    } } } });
  }
  throw new Error("Fail-closed mock rejected unconfigured VirusTotal request: " + method + " " + url.href);
};
`;
  await writeFile(path.join(tempRoot, "mock-virustotal.mjs"), mockModule);
  bundle = await buildApiIntoTemp();
  const runDir = path.join(tempRoot, "api-runtime");
  await mkdir(runDir, { recursive: true });
  apiProcess = spawn(process.execPath, ["--import", path.join(tempRoot, "mock-virustotal.mjs"), bundle], {
    cwd: runDir,
    env: {
      ...isolatedEnvironment(databaseUrl, apiPort, apiBase, {
        VIRUSTOTAL_API_KEY: `dummy-${randomUUID()}`,
        FILE_CHANNEL_MAX_MB: "1",
      }),
      VT_MOCK_LOG: mockLogPath,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  apiProcess.once("exit", () => {});
  await pollApiReady(apiProcess);
  console.log("PASS temporary API bundle started with dummy VT key and local-only mock");

  const client = account(apiBase);
  const username = `vt_smoke_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = `Disposable-${randomUUID()}!`;
  expectStatus(await client.request("/api/auth/register", {
    method: "POST", json: { username, password, displayName: "VirusTotal Smoke User" },
  }), 201, "register disposable smoke-test account");
  expectStatus(await client.request("/api/auth/login", {
    method: "POST", json: { username, password },
  }), 200, "log in to isolated API");
  const server = expectStatus(await client.request("/api/servers", {
    method: "POST", json: { name: "Disposable VirusTotal Smoke Server" },
  }), 201, "create disposable server");
  const serverId = parseId(server, "id", "server id");
  const channel = expectStatus(await client.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "vt-smoke", channelType: "media" },
  }), 201, "create disposable media channel");
  const channelId = parseId(channel, "id", "channel id");

  const bytes = syntheticZip(`smoke-${randomUUID()}`);
  const file = await uploadSyntheticZip(client, channelId, bytes);
  assert.equal(file.mimeType, "application/zip");
  assert.equal(file.scanEligibility.eligible, true);
  assert.equal(file.scanEligibility.extensionMismatch, false);
  assert.equal(file.scan.status, "not_started");
  assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
  console.log("PASS one synthetic ZIP is classified eligible before opt-in");

  const callsBeforeRejection = (await mockCalls()).length;
  expectStatus(await client.request(`/api/channels/${channelId}/files/${file.id}/verify`, {
    method: "POST", json: { consent: false },
  }), 400, "reject scan without explicit consent");
  assert.equal((await mockCalls()).length, callsBeforeRejection,
    "no-consent rejection must not contact the VirusTotal mock");
  console.log("PASS no-consent rejection emitted zero provider requests");

  const submitted = expectStatus(await client.request(`/api/channels/${channelId}/files/${file.id}/verify`, {
    method: "POST", json: { consent: true },
  }), 202, "opt-in hash-miss scan submission");
  assert.equal(submitted.status, "queued");
  assert.equal(submitted.source, "upload");
  assert.ok(submitted.submittedAt);
  const scan = await waitForScan(client, channelId, file.id);
  assert.deepEqual(
    [scan.harmless, scan.undetected, scan.suspicious, scan.malicious],
    [72, 11, 1, 0],
  );
  assert.equal(scan.source, "upload");
  assert.ok(scan.completedAt);
  console.log("PASS mocked VirusTotal analysis completed with expected engine counts");

  const calls = await mockCalls();
  assert.deepEqual(calls.map(({ method, pathname }) => [method, pathname]), [
    ["GET", `/api/v3/files/${file.sha256}`],
    ["POST", "/api/v3/files"],
    ["GET", "/api/v3/analyses/isolated-analysis-1"],
  ]);
  const uploadCall = calls.find(call => call.method === "POST");
  assert.equal(uploadCall.bytes, bytes.length, "mock received the complete synthetic ZIP");
  assert.equal(uploadCall.sha256, file.sha256, "mock received bytes matching persisted SHA-256");
  console.log("PASS provider call trace proves hash miss, content upload, and analysis completion");
  console.log("PASS exercised: disposable PostgreSQL 16 + full migrations; built isolated API; opt-in synthetic ZIP scan through local-only VirusTotal mock.");
} finally {
  await cleanup();
}