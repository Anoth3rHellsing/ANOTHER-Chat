// Isolated full-stack channel-file verification. PostgreSQL, API processes,
// private upload bytes, and VirusTotal mocks live only in a disposable /tmp tree.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
let primaryPort;
let scannerPort;
let primaryBase;
let scannerBase;
let bundle;
let mockLogPath;
let mockConfigPath;
let primaryProcess;
let scannerProcess;
const processes = [];
let pgStarted = false;
let complete = false;

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

async function assertPortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function isolatedEnvironment(databaseUrl, port, base, extras = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete env[key];
    }
  }
  delete env.VIRUSTOTAL_API_KEY;
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
  function addCookies(response) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const offset = pair.indexOf("=");
      if (offset > 0) cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
    }
  }
  function headers(method, provided = {}) {
    const result = { ...provided };
    if (cookies.size) result.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (cookies.has("csrf_token") && method !== "GET" && method !== "HEAD") {
      result["x-csrf-token"] = cookies.get("csrf_token");
    }
    return result;
  }
  return {
    cookies,
    async request(url, { method = "GET", json, body, headers: provided = {} } = {}) {
      const requestHeaders = headers(method, provided);
      let requestBody = body;
      if (json !== undefined) {
        requestHeaders["Content-Type"] = "application/json";
        requestBody = JSON.stringify(json);
      }
      const response = await fetch(base + url, { method, headers: requestHeaders, body: requestBody });
      addCookies(response);
      const raw = await response.text();
      let result;
      try { result = JSON.parse(raw); } catch { result = raw; }
      return { status: response.status, result, headers: response.headers };
    },
    async raw(url, { method = "GET", headers: provided = {} } = {}) {
      const response = await fetch(base + url, { method, headers: headers(method, provided) });
      addCookies(response);
      return response;
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

async function pollApiReady(process, base) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      const response = await fetch(`${base}/api/auth/me`);
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

async function startApi(port, base, runDir, { virusTotal = false, maxMb = 1 } = {}) {
  await mkdir(runDir, { recursive: true });
  const extras = {
    FILE_CHANNEL_MAX_MB: String(maxMb),
    ...(virusTotal ? { VIRUSTOTAL_API_KEY: `dummy-${randomUUID()}` } : {}),
  };
  const env = isolatedEnvironment(
    `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${database}`,
    port,
    base,
    extras,
  );
  const args = virusTotal ? ["--import", path.join(tempRoot, "mock-virustotal.mjs"), bundle] : [bundle];
  const child = spawn(process.execPath, args, {
    cwd: runDir,
    env: { ...env, VT_MOCK_LOG: mockLogPath, VT_MOCK_CONFIG: mockConfigPath },
    stdio: ["ignore", "ignore", "ignore"],
  });
  processes.push(child);
  child._exit = once(child, "exit");
  await pollApiReady(child, base);
  return child;
}

function sql(statement) {
  return run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, "-d", database,
    "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", statement,
  ], { env: dbEnv }).trim();
}

async function register(accountClient, username, displayName, inviteCode) {
  const password = accountClient.password;
  expectStatus(await accountClient.request("/api/auth/register", {
    method: "POST",
    json: { username, password, displayName, ...(inviteCode ? { inviteCode } : {}) },
  }), 201, `register synthetic ${displayName}`);
  const login = expectStatus(await accountClient.request("/api/auth/login", {
    method: "POST",
    json: { username, password: accountClient.password },
  }), 200, `normal HTTP login for ${displayName}`);
  return login;
}

async function createUpload(client, channelId, filename, bytes, label) {
  const initialized = expectStatus(await client.request(`/api/channels/${channelId}/files/uploads`, {
    method: "POST",
    json: { filename, sizeBytes: bytes.length },
  }), 201, `${label}: initialize upload`);
  assert.equal(initialized.offset, 0);
  const form = new FormData();
  form.append("chunk", new Blob([bytes], { type: "application/octet-stream" }), "chunk.bin");
  const chunk = expectStatus(await client.request(
    `/api/channels/${channelId}/files/uploads/${initialized.uploadId}/chunks?offset=0`,
    { method: "POST", body: form },
  ), 200, `${label}: submit multipart chunk`);
  assert.equal(chunk.offset, bytes.length);
  assert.equal(chunk.complete, true);
  const finished = await client.request(
    `/api/channels/${channelId}/files/uploads/${initialized.uploadId}/finish`,
    { method: "POST" },
  );
  return { initialized, finished };
}

async function sendChunk(client, channelId, uploadId, offset, bytes) {
  const form = new FormData();
  form.append("chunk", new Blob([bytes], { type: "application/octet-stream" }), "chunk.bin");
  return client.request(
    `/api/channels/${channelId}/files/uploads/${uploadId}/chunks?offset=${offset}`,
    { method: "POST", body: form },
  );
}

async function waitForScan(client, channelId, fileId, expected, label) {
  const deadline = Date.now() + 15_000;
  let scan;
  while (Date.now() < deadline) {
    const response = await client.request(`/api/channels/${channelId}/files/${fileId}/scan`);
    assert.equal(response.status, 200, `${label} scan status endpoint: ${JSON.stringify(response.result)}`);
    scan = response.result;
    if (scan.status === expected) break;
    if (scan.status === "error" && expected !== "error") {
      throw new Error(`${label} entered scan error: ${JSON.stringify(scan)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(scan?.status, expected, `${label} did not reach ${expected}: ${JSON.stringify(scan)}`);
  return scan;
}

async function uploadTestFile(client, channelId, filename, bytes, label) {
  const { finished } = await createUpload(client, channelId, filename, bytes, label);
  const file = expectStatus(finished, 201, `${label}: finish and persist file`);
  return file;
}

async function cleanup() {
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([child._exit, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child._exit;
      }
    }
  }
  if (pgStarted) {
    run(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"]);
    pgStarted = false;
  }
  for (const child of processes) {
    assert.ok(child.exitCode !== null || child.signalCode !== null, "temporary API process must exit");
    assert.throws(() => process.kill(child.pid, 0), "temporary API process must no longer exist");
  }
  if (pgData && pgBin) {
    const status = spawnSync(path.join(pgBin, "pg_ctl"), ["-D", pgData, "status"], { encoding: "utf8" });
    assert.notEqual(status.status, 0, "temporary PostgreSQL server must no longer be running");
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

try {
  assert.equal(os.tmpdir(), "/tmp", "this test requires temporary data under /tmp");
  pgBin = postgresBinDirectory();
  if (!pgBin) throw new Error("PostgreSQL 16 initdb/pg_ctl/createdb/psql binaries are unavailable");
  const version = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(version, /PostgreSQL\) 16\b/, `Expected PostgreSQL 16, got ${version.trim()}`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "file-channel-integration-"));
  pgData = path.join(tempRoot, "postgres-data");
  const logPath = path.join(tempRoot, "postgres.log");
  pgPort = await reserveFreePort();
  primaryPort = await reserveFreePort();
  scannerPort = await reserveFreePort();
  await assertPortFree(primaryPort);
  await assertPortFree(scannerPort);
  primaryBase = `http://127.0.0.1:${primaryPort}`;
  scannerBase = `http://127.0.0.1:${scannerPort}`;
  database = `files_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  pgUser = os.userInfo().username;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${database}`;
  dbEnv = isolatedEnvironment(databaseUrl, primaryPort, primaryBase);

  run(path.join(pgBin, "initdb"), [
    "-D", pgData, "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust",
  ], { env: dbEnv });
  run(path.join(pgBin, "pg_ctl"), [
    "-D", pgData, "-l", logPath,
    "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${tempRoot}`,
    "-w", "start",
  ], { env: dbEnv });
  pgStarted = true;
  run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, database], { env: dbEnv });

  const migration = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"], {
    cwd: databaseRoot,
    env: dbEnv,
    encoding: "utf8",
  });
  if (migration.error || migration.status !== 0) {
    throw new Error(`Full versioned Drizzle migration chain failed (${migration.error?.message ?? `exit ${migration.status}`})\n${migration.stderr ?? ""}`);
  }
  console.log("PASS full versioned Drizzle migration chain applied to empty temporary PostgreSQL 16 database");

  mockLogPath = path.join(tempRoot, "vt-mock-calls.jsonl");
  mockConfigPath = path.join(tempRoot, "vt-mock-config.json");
  await writeFile(mockLogPath, "");
  await writeFile(mockConfigPath, JSON.stringify({ quotaHashes: [] }));
  const mockModule = `
import { appendFileSync, readFileSync } from "node:fs";
const originalFetch = globalThis.fetch.bind(globalThis);
const logFile = process.env.VT_MOCK_LOG;
const configFile = process.env.VT_MOCK_CONFIG;
const analyses = new Map();
let analysisNumber = 0;
const reply = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const isVirusTotal = url.hostname === "virustotal.com" || url.hostname.endsWith(".virustotal.com");
  if (!isVirusTotal) return originalFetch(input, init);
  const method = init.method ?? (typeof input === "object" ? input.method : undefined) ?? "GET";
  const pathname = url.pathname;
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  appendFileSync(logFile, JSON.stringify({ method, pathname, hostname: url.hostname }) + "\\n");
  if (method === "GET" && pathname === "/api/v3/files/upload_url") {
    return reply(200, { data: "https://upload.virustotal.com/upload/isolated" });
  }
  if (method === "GET" && pathname.startsWith("/api/v3/files/")) {
    const hash = pathname.slice("/api/v3/files/".length);
    if ((config.quotaHashes ?? []).includes(hash)) {
      return reply(200, { data: { attributes: { last_analysis_stats: {
        harmless: 68, undetected: 12, suspicious: 1, malicious: 0,
      } } } });
    }
    return reply(404, { error: { message: "Mock hash report not found" } });
  }
  if (method === "POST" && pathname === "/api/v3/files") {
    const file = init.body?.get?.("file");
    const bytes = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
    const failed = bytes.includes(Buffer.from("VT_FAIL_SCAN"));
    const fast = bytes.includes(Buffer.from("VT_LARGE_SCAN"));
    const id = "mock-analysis-" + (++analysisNumber);
    analyses.set(id, { failed, fast, polls: 0 });
    return reply(200, { data: { id } });
  }
  if (method === "POST" && url.hostname === "upload.virustotal.com" && pathname === "/upload/isolated") {
    const file = init.body?.get?.("file");
    const bytes = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
    const failed = bytes.includes(Buffer.from("VT_FAIL_SCAN"));
    const id = "mock-analysis-" + (++analysisNumber);
    analyses.set(id, { failed, fast: true, polls: 0 });
    return reply(200, { data: { id } });
  }
  if (method === "GET" && pathname.startsWith("/api/v3/analyses/")) {
    const id = decodeURIComponent(pathname.slice("/api/v3/analyses/".length));
    const analysis = analyses.get(id);
    if (!analysis) return reply(404, { error: { message: "Unknown mock analysis" } });
    analysis.polls++;
    if (analysis.failed) return reply(200, { data: { attributes: { status: "failed" } } });
    if (analysis.fast) return reply(200, { data: { attributes: { status: "completed", stats: {
      harmless: 72, undetected: 11, suspicious: 1, malicious: 0,
    } } } });
    if (analysis.polls === 1) return reply(200, { data: { attributes: { status: "queued" } } });
    return reply(200, { data: { attributes: { status: "completed", stats: {
      harmless: 72, undetected: 11, suspicious: 1, malicious: 0,
    } } } });
  }
  // Deliberately fail closed: the isolated test never forwards VT traffic.
  return reply(501, { error: { message: "Unconfigured isolated VirusTotal mock endpoint: " + method + " " + pathname } });
};
`;
  await writeFile(path.join(tempRoot, "mock-virustotal.mjs"), mockModule);
  bundle = await buildApiIntoTemp();
  console.log("PASS current API bundle built in /tmp; all channel-file storage is process-cwd isolated");

  primaryProcess = await startApi(primaryPort, primaryBase, path.join(tempRoot, "api-no-key"), {});
  console.log("PASS isolated API without VirusTotal key is serving on a temporary port");

  const admin = account(primaryBase);
  const uploader = account(primaryBase);
  const helper = account(primaryBase);
  const outsider = account(primaryBase);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminName = `file_admin_${suffix}`;
  const uploaderName = `file_uploader_${suffix}`;
  const helperName = `file_helper_${suffix}`;
  const outsiderName = `file_outsider_${suffix}`;
  admin.password = `Disposable-${randomUUID()}!`;
  uploader.password = `Disposable-${randomUUID()}!`;
  helper.password = `Disposable-${randomUUID()}!`;
  outsider.password = `Disposable-${randomUUID()}!`;

  await register(admin, adminName, "Temporary File Admin");
  const creatorInvite = expectStatus(await admin.request("/api/admin/invites", { method: "POST", json: {} }),
    201, "create disposable registration invite for uploader");
  const outsiderInvite = expectStatus(await admin.request("/api/admin/invites", { method: "POST", json: {} }),
    201, "create disposable registration invite for outsider");
  const helperInvite = expectStatus(await admin.request("/api/admin/invites", { method: "POST", json: {} }),
    201, "create disposable registration invite for server member");
  await register(uploader, uploaderName, "Temporary File Uploader", creatorInvite.code);
  await register(helper, helperName, "Temporary File Member", helperInvite.code);
  await register(outsider, outsiderName, "Temporary File Outsider", outsiderInvite.code);

  const server = expectStatus(await uploader.request("/api/servers", {
    method: "POST", json: { name: "Temporary File Integration Server" },
  }), 201, "create disposable server");
  const serverId = parseId(server, "id", "server id");
  const adminInvite = expectStatus(await uploader.request(`/api/servers/${serverId}/invites`, {
    method: "POST", json: {},
  }), 201, "create server invite for administrator");
  expectStatus(await admin.request("/api/servers/join-by-invite", {
    method: "POST", json: { code: adminInvite.code },
  }), 200, "administrator joins disposable server");
  expectStatus(await uploader.request(`/api/servers/${serverId}/members/${(await admin.request("/api/auth/me")).result.id}/role`, {
    method: "PATCH", json: { role: "admin" },
  }), 200, "assign temporary server-admin role");
  const adminMe = (await admin.request("/api/auth/me")).result;
  sql(`UPDATE users SET role = 'member' WHERE id = ${adminMe.id}`);
  const refreshedAdmin = expectStatus(await admin.request("/api/auth/login", {
    method: "POST", json: { username: adminName, password: admin.password },
  }), 200, "refresh admin login with server-only admin membership");
  assert.equal(refreshedAdmin.role, "member", "authorization must exercise server-admin, not global-admin, access");

  const helperServerInvite = expectStatus(await uploader.request(`/api/servers/${serverId}/invites`, {
    method: "POST", json: {},
  }), 201, "create server invite for non-uploader member");
  expectStatus(await helper.request("/api/servers/join-by-invite", {
    method: "POST", json: { code: helperServerInvite.code },
  }), 200, "non-uploader member joins disposable server");
  const channel = expectStatus(await uploader.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "files-integration", channelType: "media" },
  }), 201, "create disposable media channel");
  const channelId = parseId(channel, "id", "media channel id");

  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const primaryStorage = path.join(tempRoot, "api-no-key", "private-channel-files", "data");
  const beforePrimaryFiles = new Set(await readdir(primaryStorage));
  const uploaded = await uploadTestFile(uploader, channelId, "Fixture.png", png, "real media file");
  assert.equal(uploaded.mimeType, "image/png");
  assert.equal(uploaded.sizeBytes, png.length);
  assert.equal(uploaded.scan.status, "unavailable");
  const fileOnDisk = (await readdir(primaryStorage)).find(name => !beforePrimaryFiles.has(name));
  assert.ok(fileOnDisk, "finished file must have private on-disk bytes");
  console.log("PASS successful upload created private bytes under the isolated /tmp API cwd");

  const listing = expectStatus(await uploader.request(`/api/channels/${channelId}/files`),
    200, "list file metadata");
  assert.equal(listing.scannerAvailable, false);
  assert.equal(listing.maxBytes, 1024 * 1024);
  assert.ok(listing.files.some(file => file.id === uploaded.id && file.filename === "Fixture.png"));
  assert.equal(uploaded.downloadPath, `/api/channels/${channelId}/files/${uploaded.id}/download`);
  console.log("PASS metadata includes private download path, scannerAvailable:false, and 1 MiB limit");

  const download = await uploader.raw(uploaded.downloadPath);
  assert.equal(download.status, 200, "authorized download status");
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-security-policy"), /sandbox/);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.match(download.headers.get("cache-control"), /no-store/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);
  console.log("PASS guarded download returns exact uploaded bytes and safe attachment headers");

  expectStatus(await outsider.request(`/api/channels/${channelId}/files`), 403,
    "outsider cannot list files in private media channel");
  const outsiderDownload = await outsider.raw(uploaded.downloadPath);
  assert.equal(outsiderDownload.status, 403, "outsider download must be denied");
  await outsiderDownload.arrayBuffer();
  console.log("PASS outsider cannot download private file bytes (403)");
  expectStatus(await helper.request(`/api/channels/${channelId}/files/${uploaded.id}`, { method: "DELETE" }),
    403, "non-uploader member cannot delete uploader file");
  expectStatus(await outsider.request(`/api/channels/${channelId}/files/${uploaded.id}`, { method: "DELETE" }),
    403, "outsider cannot delete uploader file");
  expectStatus(await admin.request(`/api/channels/${channelId}/files/${uploaded.id}`, { method: "DELETE" }),
    204, "server admin deletes uploader file");
  assert.ok(!(await readdir(primaryStorage)).includes(fileOnDisk), "admin delete must remove physical private bytes");
  console.log("PASS server-admin delete removed file bytes from disk");

  const beforeUploaderDeleteFiles = new Set(await readdir(primaryStorage));
  const uploaderFile = await uploadTestFile(uploader, channelId, "uploader-delete.png", png, "uploader deletion fixture");
  const uploaderStorageName = (await readdir(primaryStorage)).find(name => !beforeUploaderDeleteFiles.has(name));
  assert.ok(uploaderStorageName);
  expectStatus(await uploader.request(`/api/channels/${channelId}/files/${uploaderFile.id}`, { method: "DELETE" }),
    204, "uploader deletes own file");
  assert.ok(!(await readdir(primaryStorage)).includes(uploaderStorageName), "uploader delete must remove physical private bytes");
  console.log("PASS uploader delete removed file bytes from disk");

  expectStatus(await uploader.request(`/api/channels/${channelId}/files/uploads`, {
    method: "POST", json: { filename: "too-large.png", sizeBytes: 1024 * 1024 + 1 },
  }), 413, "reject oversized file at upload initialization");
  const badUpload = await createUpload(uploader, channelId, "bad.bin", Buffer.from([0x4d, 0x5a, 0, 0, 0, 0]), "invalid signature");
  expectStatus(badUpload.finished, 415, "reject unsupported file magic on finish");
  const noKeyListing = expectStatus(await uploader.request(`/api/channels/${channelId}/files`),
    200, "confirm scanner availability without configured key");
  assert.equal(noKeyListing.scannerAvailable, false);
  expectStatus(await uploader.request(`/api/channels/${channelId}/files/${uploaderFile.id}/verify`, {
    method: "POST", json: { consent: true },
  }), 404, "deleted files cannot be verified");

  const keylessFixture = await uploadTestFile(
    uploader, channelId, "keyless.png", png, "keyless scan availability fixture",
  );
  expectStatus(await uploader.request(`/api/channels/${channelId}/files/${keylessFixture.id}/verify`, {
    method: "POST", json: { consent: true },
  }), 503, "verification explicitly unavailable without VirusTotal key");
  console.log("PASS keyless fixture reports scannerAvailable:false and verify returns 503");

  scannerProcess = await startApi(
    scannerPort, scannerBase, path.join(tempRoot, "api-with-mock-vt"),
    { virusTotal: true, maxMb: 100 },
  );
  console.log("PASS second isolated API started with dummy VirusTotal key, 100 MiB limit, and test-only fetch mock");
  const scannerUploader = account(scannerBase);
  const scannerAdmin = account(scannerBase);
  const scannerHelper = account(scannerBase);
  for (const [client, username, password] of [
    [scannerUploader, uploaderName, uploader.password],
    [scannerAdmin, adminName, admin.password],
    [scannerHelper, helperName, helper.password],
  ]) {
    client.password = password;
    expectStatus(await client.request("/api/auth/login", {
      method: "POST", json: { username, password },
    }), 200, `normal HTTP login against mocked-scanner API (${username})`);
  }

  const scannerStorage = path.join(tempRoot, "api-with-mock-vt", "private-channel-files", "data");
  const mockCalls = async () => {
    const raw = await readFile(mockLogPath, "utf8");
    return raw.trim() ? raw.trim().split("\n").map(line => JSON.parse(line)) : [];
  };

  const chunkBytes = 4 * 1024 * 1024;
  const candidateA = Buffer.alloc(chunkBytes, 0x31);
  const candidateB = Buffer.alloc(chunkBytes, 0x32);
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  pngHeader.copy(candidateA);
  pngHeader.copy(candidateB);
  const resumedTail = Buffer.alloc(113, 0x44);
  const resumedInit = expectStatus(await scannerUploader.request(`/api/channels/${channelId}/files/uploads`, {
    method: "POST", json: { filename: "concurrent-resume.png", sizeBytes: chunkBytes + resumedTail.length },
  }), 201, "initialize interrupted concurrent upload fixture");
  assert.equal(chunkBytes, 4_194_304);
  assert.equal(resumedInit.chunkSize, chunkBytes);
  const sameOffsetResults = await Promise.all([
    sendChunk(scannerUploader, channelId, resumedInit.uploadId, 0, candidateA),
    sendChunk(scannerUploader, channelId, resumedInit.uploadId, 0, candidateB),
  ]);
  const acceptedIndexes = sameOffsetResults.map((result, index) => result.status === 200 ? index : -1).filter(index => index >= 0);
  const conflictIndexes = sameOffsetResults.map((result, index) => result.status === 409 ? index : -1).filter(index => index >= 0);
  assert.equal(acceptedIndexes.length, 1, `exactly one competing chunk must be accepted: ${JSON.stringify(sameOffsetResults.map(r => [r.status, r.result]))}`);
  assert.equal(conflictIndexes.length, 1, `the competing chunk must conflict: ${JSON.stringify(sameOffsetResults.map(r => [r.status, r.result]))}`);
  const acceptedChunk = acceptedIndexes[0] === 0 ? candidateA : candidateB;
  assert.equal(sameOffsetResults[acceptedIndexes[0]].result.offset, 4_194_304);
  console.log("PASS concurrent conflicting same-offset chunks accepted exactly one and rejected the other with 409");

  const uploadStatusPath = `/api/channels/${channelId}/files/uploads/${resumedInit.uploadId}`;
  const interruptedStatus = expectStatus(await scannerUploader.request(uploadStatusPath), 200,
    "read authoritative interrupted-upload status");
  assert.equal(interruptedStatus.uploadId, resumedInit.uploadId);
  assert.equal(interruptedStatus.offset, chunkBytes);
  assert.equal(interruptedStatus.expectedBytes, chunkBytes + resumedTail.length);
  assert.equal("completedFileId" in interruptedStatus, false);
  const resumedChunk = expectStatus(await sendChunk(
    scannerUploader, channelId, resumedInit.uploadId, interruptedStatus.offset, resumedTail,
  ), 200, "resume interrupted upload at server-reported offset with final chunk");
  assert.equal(resumedChunk.offset, chunkBytes + resumedTail.length);
  console.log("PASS interrupted upload status exposes authoritative offset and resumes with the final chunk");

  const resumedFile = expectStatus(await scannerUploader.request(
    `/api/channels/${channelId}/files/uploads/${resumedInit.uploadId}/finish`,
    { method: "POST" },
  ), 201, "finish resumed concurrent upload");
  const repeatedFinish = expectStatus(await scannerUploader.request(
    `/api/channels/${channelId}/files/uploads/${resumedInit.uploadId}/finish`,
    { method: "POST" },
  ), 200, "repeat finish idempotently");
  assert.equal(repeatedFinish.id, resumedFile.id, "repeated finish must return the same file id");
  const completedStatus = expectStatus(await scannerUploader.request(uploadStatusPath), 200,
    "read authoritative completed-upload status");
  assert.equal(completedStatus.offset, chunkBytes + resumedTail.length);
  assert.equal(completedStatus.completedFileId, resumedFile.id);
  console.log("PASS repeated finish returns the same file id and status records completedFileId");

  expectStatus(await scannerUploader.request(
    `/api/channels/${channelId}/files/uploads/${resumedInit.uploadId}`,
    { method: "DELETE" },
  ), 204, "abort completed upload session is a harmless no-op");
  const resumedDownload = await scannerUploader.raw(resumedFile.downloadPath);
  assert.equal(resumedDownload.status, 200);
  const resumedDownloadedBytes = Buffer.from(await resumedDownload.arrayBuffer());
  assert.deepEqual(resumedDownloadedBytes, Buffer.concat([acceptedChunk, resumedTail]));
  assert.ok((await readdir(scannerStorage)).length > 0, "aborting completed session must retain finalized file bytes");
  console.log("PASS abort-after-completion preserves finalized bytes matching the acknowledged chunk");

  const oversizedChunkInit = expectStatus(await scannerUploader.request(`/api/channels/${channelId}/files/uploads`, {
    method: "POST", json: { filename: "oversized-chunk.png", sizeBytes: chunkBytes + 1 },
  }), 201, "initialize upload for one-byte-over-limit chunk");
  const oversizedChunk = await sendChunk(
    scannerUploader, channelId, oversizedChunkInit.uploadId, 0,
    Buffer.concat([pngHeader, Buffer.alloc(chunkBytes + 1 - pngHeader.length)]),
  );
  expectStatus(oversizedChunk, 413, "reject multipart chunk of 4 MiB plus one byte");
  expectStatus(await scannerUploader.request(
    `/api/channels/${channelId}/files/uploads/${oversizedChunkInit.uploadId}`,
    { method: "DELETE" },
  ), 204, "clean up oversized chunk upload fixture");

  const consentFixture = await uploadTestFile(scannerUploader, channelId, "consent.png", png, "explicit consent fixture");
  assert.equal((await mockCalls()).length, 0, "file upload alone must make no VirusTotal request");
  expectStatus(await scannerUploader.request(`/api/channels/${channelId}/files/${consentFixture.id}/verify`, {
    method: "POST", json: { consent: false },
  }), 400, "explicit consent:false rejected");
  assert.equal((await mockCalls()).length, 0, "consent:false must make zero outbound requests");
  console.log("PASS consent:false returns 400 with zero mocked outbound requests");

  const scanBytes = Buffer.concat([png, Buffer.from("scanner-success-content")]);
  const scanFile = await uploadTestFile(scannerUploader, channelId, "scan-me.png", scanBytes, "VirusTotal mock scan");
  const submitted = expectStatus(await scannerUploader.request(`/api/channels/${channelId}/files/${scanFile.id}/verify`, {
    method: "POST", json: { consent: true },
  }), 202, "consented hash-miss file submitted to mock scanner");
  assert.equal(submitted.status, "queued");
  assert.equal(submitted.source, "upload");
  assert.ok(submitted.submittedAt);
  const completedScan = await waitForScan(scannerUploader, channelId, scanFile.id, "completed", "mock completed analysis");
  assert.deepEqual(
    [completedScan.harmless, completedScan.undetected, completedScan.suspicious, completedScan.malicious],
    [72, 11, 1, 0],
  );
  assert.equal(completedScan.source, "upload");
  const successfulCalls = await mockCalls();
  assert.ok(successfulCalls.some(call => call.method === "GET" && /^\/api\/v3\/files\//.test(call.pathname)),
    "mock should answer hash lookup with 404");
  assert.ok(successfulCalls.some(call => call.method === "POST" && call.pathname === "/api/v3/files"),
    "hash miss should submit file bytes to mocked VT endpoint");
  assert.ok(successfulCalls.some(call => call.pathname.startsWith("/api/v3/analyses/")),
    "analysis must be polled through queued and completed mock states");
  console.log("PASS mock reports hash 404, content upload, queued analysis, then completed antivirus statistics");

  const duplicateFile = await uploadTestFile(scannerUploader, channelId, "same-content.png", scanBytes, "same-content reuse fixture");
  const callsBeforeReuse = (await mockCalls()).length;
  const reused = expectStatus(await scannerUploader.request(`/api/channels/${channelId}/files/${duplicateFile.id}/verify`, {
    method: "POST", json: { consent: true },
  }), 200, "same-content file reuses completed local scan");
  assert.equal(reused.status, "completed");
  assert.equal(reused.source, "local");
  assert.equal((await mockCalls()).length, callsBeforeReuse, "local report reuse must make no repeated VirusTotal requests");
  console.log("PASS identical content reused local completed report without another content POST or any VT request");

  const failedBytes = Buffer.concat([png, Buffer.from("VT_FAIL_SCAN")]);
  const failedFile = await uploadTestFile(scannerUploader, channelId, "failed-analysis.png", failedBytes, "failed analysis fixture");
  sql("DELETE FROM virus_total_requests");
  expectStatus(await scannerUploader.request(`/api/channels/${channelId}/files/${failedFile.id}/verify`, {
    method: "POST", json: { consent: true },
  }), 202, "submit deliberately failing mocked analysis");
  const failedScan = await waitForScan(scannerUploader, channelId, failedFile.id, "error", "failed mock analysis");
  assert.notEqual(failedScan.status, "completed");
  assert.notEqual(failedScan.harmless, 0, "failed mock analysis must not be misreported as clean");
  assert.equal(failedScan.malicious, null);
  assert.match(failedScan.error, /unexpected state: failed/);
  console.log("PASS a failed provider analysis stays error and is never represented as completed/clean");

  const largeSize = 32 * 1024 * 1024 + 1;
  const largeMarker = Buffer.from("VT_LARGE_SCAN");
  const largeBytes = Buffer.alloc(largeSize);
  png.subarray(0, 8).copy(largeBytes);
  largeMarker.copy(largeBytes, largeBytes.length - largeMarker.length);
  const largeStorageKey = randomUUID();
  await writeFile(path.join(scannerStorage, largeStorageKey), largeBytes, { mode: 0o600 });
  const largeHash = createHash("sha256").update(largeBytes).digest("hex");
  const largeFileId = Number(sql(
    `INSERT INTO channel_files (channel_id, uploaded_by, filename, mime_type, size_bytes, sha256, storage_key) ` +
    `SELECT ${channelId}, id, 'large-upload-url.png', 'image/png', ${largeSize}, '${largeHash}', '${largeStorageKey}' ` +
    `FROM users WHERE username = '${uploaderName}' RETURNING id`,
  ));
  assert.ok(Number.isSafeInteger(largeFileId) && largeFileId > 0);
  sql("DELETE FROM virus_total_requests");
  const callsBeforeLargeScan = (await mockCalls()).length;
  expectStatus(await scannerHelper.request(`/api/channels/${channelId}/files/${largeFileId}/verify`, {
    method: "POST", json: { consent: true },
  }), 202, "submit >32 MiB file through mocked VirusTotal upload_url flow");
  const largeScan = await waitForScan(
    scannerHelper, channelId, largeFileId, "completed", "mock large-file upload_url analysis",
  );
  assert.equal(largeScan.source, "upload");
  const largeCalls = (await mockCalls()).slice(callsBeforeLargeScan);
  assert.ok(largeCalls.some(call => call.method === "GET" && call.pathname === "/api/v3/files/upload_url"),
    "large-file flow must request a VirusTotal upload URL");
  const largePost = largeCalls.find(call => call.method === "POST" && call.pathname === "/upload/isolated");
  assert.equal(largePost?.hostname, "upload.virustotal.com",
    "mock must observe the content POST only to the safe VirusTotal upload hostname");
  assert.ok(largeCalls.some(call => call.method === "GET" && call.pathname.startsWith("/api/v3/analyses/")),
    "large-file upload analysis must complete through the mock");
  console.log("PASS >32 MiB synthetic file obtained safe upload_url host and posted content only to that mock host");

  const quotaFiles = [];
  for (let index = 0; index < 5; index++) {
    const bytes = Buffer.concat([png, Buffer.from(`quota-hash-${index}-${randomUUID()}`)]);
    quotaFiles.push(await uploadTestFile(
      scannerUploader, channelId, `quota-${index}.png`, bytes, `quota file ${index + 1}`,
    ));
  }
  const quotaHashes = quotaFiles.map(file => file.sha256);
  await writeFile(mockConfigPath, JSON.stringify({ quotaHashes }));
  sql("DELETE FROM virus_total_requests");
  const callsBeforeQuota = (await mockCalls()).length;
  for (let index = 0; index < 4; index++) {
    expectStatus(await scannerAdmin.request(`/api/channels/${channelId}/files/${quotaFiles[index].id}/verify`, {
      method: "POST", json: { consent: true },
    }), 200, `mocked VirusTotal quota allows request ${index + 1}`);
  }
  const quotaDenied = await scannerHelper.request(`/api/channels/${channelId}/files/${quotaFiles[4].id}/verify`, {
    method: "POST", json: { consent: true },
  });
  expectStatus(quotaDenied, 429, "mocked VirusTotal provider quota rejects fifth distinct hash lookup");
  const quotaCalls = (await mockCalls()).slice(callsBeforeQuota);
  assert.equal(quotaCalls.length, 4, "fifth distinct hash must be rejected before an outbound request");
  assert.ok(quotaCalls.every(call => call.method === "GET" && call.pathname.startsWith("/api/v3/files/")));
  console.log("PASS four-per-minute provider quota returns 429 on fifth distinct hash without fifth outbound request");

  const scannerListing = expectStatus(await scannerUploader.request(`/api/channels/${channelId}/files`),
    200, "list metadata while dummy VirusTotal key is configured");
  assert.equal(scannerListing.scannerAvailable, true);
  console.log("PASS scannerAvailable reflects dummy configured key only in the second isolated API instance");

  complete = true;
} finally {
  try {
    await cleanup();
  } catch (error) {
    if (complete) throw error;
    console.error(`CLEANUP FAILURE: ${error.message}`);
  }
}

if (!complete) throw new Error("Isolated channel-file integration verification did not complete");
console.log("PASS isolated PostgreSQL cluster, both API processes, and all /tmp fixtures stopped/removed");
console.log("PASS exercised: PostgreSQL 16 + full Drizzle migration; synthetic signup/login, server-admin and outsider; media upload, concurrent chunk conflict, authoritative status/resume, idempotent finish, post-finish abort safety, metadata/download/access/deletion, size/magic rejection; keyless scanner behavior; mocked VirusTotal consent, hash miss/upload, queued/completed/failure/local reuse, >32 MiB safe upload_url flow, and quota. No development DB or real VirusTotal endpoint used.");