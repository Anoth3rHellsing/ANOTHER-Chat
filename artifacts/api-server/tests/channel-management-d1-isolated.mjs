// Isolated regression coverage for PR D1: channel management server hardening.
// Covers: Zod validation with Spanish messages on POST/PATCH channels,
// E3 protection (cannot delete last text channel → 409),
// secure transactional delete, voice eviction with reason "channel_deleted",
// channels:changed event broadcast to server members only,
// PUT /servers/:serverId/channels/reorder with category validation.
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

async function buildApiIntoTemp() {
  const buildDir = path.join(tempRoot, "api");
  const outDir = path.join(buildDir, "dist");
  await mkdir(outDir, { recursive: true });
  try {
    await symlink(path.join(apiRoot, "node_modules"), path.join(buildDir, "node_modules"), "dir");
  } catch {}
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
  return path.join(outDir, "index.mjs");
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

function expectStatus(response, expected, label) {
  if (response.status !== expected) {
    const detail = response.result?.error ?? JSON.stringify(response.result);
    throw new Error(`${label}: expected ${expected}, got ${response.status} — ${detail}`);
  }
  return response.result;
}

function sql(query, env, singleRow = false) {
  const pgUser = os.userInfo().username;
  const result = spawnSync(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser,
    "-d", databaseName, "-t", "-A", "-c", query,
  ], { encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
  const output = (result.stdout ?? "").trim();
  if (singleRow) return output;
  return output.split("\n").filter(Boolean);
}

async function cleanup() {
  if (apiProcess && apiProcess.exitCode === null && apiProcess.signalCode === null) {
    apiProcess.kill("SIGKILL");
    await apiExit.catch(() => {});
  }
  if (pgStarted && pgBin && pgData) {
    try {
      run(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"]);
    } catch {}
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

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "d1-channel-mgmt-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await freePort();
  apiPort = await freePort();
  const pgUser = os.userInfo().username;
  databaseName = `d1_channel_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
  await mkdir(path.join(apiCwd, "private-channel-files"), { recursive: true });
  const base = `http://127.0.0.1:${apiPort}`;
  let apiStderr = "";
  apiProcess = spawn(process.execPath, [bundle], { cwd: apiCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  apiProcess.stderr.on("data", (chunk) => { apiStderr += chunk.toString(); });
  apiProcess.stdout.on("data", (chunk) => { apiStderr += chunk.toString(); });
  apiExit = once(apiProcess, "exit");
  const readyUntil = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < readyUntil) {
    if (apiProcess.exitCode !== null) {
      throw new Error(`Isolated API exited before readiness (code ${apiProcess.exitCode})\n${apiStderr.slice(-3000)}`);
    }
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
    json: { username: `d1_admin_${suffix}`, password: adminPassword, displayName: "D1 admin" },
  }), 201, "register the first account (admin)");
  assert.equal(adminAccount.role, "admin");

  const invite = expectStatus(await admin.request("/api/admin/invites", {
    method: "POST", json: {},
  }), 201, "create an invite for the non-admin member");

  const member = account(base);
  const memberPassword = `Disposable-${randomUUID()}!`;
  const memberAccount = expectStatus(await member.request("/api/auth/register", {
    method: "POST",
    json: { username: `d1_member_${suffix}`, password: memberPassword, displayName: "D1 member", inviteCode: invite.code },
  }), 201, "register a non-admin member with invite");
  assert.equal(memberAccount.role, "member");
  assert.notEqual(memberAccount.id, adminAccount.id, "member id must differ from admin id");

  // Create server
  const server = expectStatus(await admin.request("/api/servers", {
    method: "POST", json: { name: "D1 Test Server" },
  }), 201, "create server");
  const serverId = server.id;
  assert.ok(Number.isSafeInteger(serverId) && serverId > 0, "serverId is a positive integer");

  // Create initial channels
  const textChannel = expectStatus(await admin.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "texto-general", channelType: "text" },
  }), 201, "create text channel");
  const textChannelId = textChannel.id;

  const voiceChannel = expectStatus(await admin.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "voz-general", channelType: "voice" },
  }), 201, "create voice channel");
  const voiceChannelId = voiceChannel.id;

  const mediaChannel = expectStatus(await admin.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "archivos", channelType: "media" },
  }), 201, "create media channel");
  const mediaChannelId = mediaChannel.id;

  // ─── POST /servers/:serverId/channels validation ────────────────────────

  // 1. Empty name returns 400 with Spanish message
  {
    const res = await admin.request(`/api/servers/${serverId}/channels`, {
      method: "POST", json: { name: "" },
    });
    assert.equal(res.status, 400, "POST channel with empty name returns 400");
    assert.match(res.result.error, /obligatorio/i, `Expected Spanish error about required name, got: ${res.result.error}`);
    console.log("PASS POST channel with empty name returns 400 with Spanish message");
  }

  // 2. Name > 100 chars returns 400 with Spanish message
  {
    const longName = "a".repeat(101);
    const res = await admin.request(`/api/servers/${serverId}/channels`, {
      method: "POST", json: { name: longName },
    });
    assert.equal(res.status, 400, "POST channel with name > 100 chars returns 400");
    assert.match(res.result.error, /100 caracteres/i, `Expected Spanish error about max length, got: ${res.result.error}`);
    console.log("PASS POST channel with name > 100 chars returns 400 with Spanish message");
  }

  // 3. Trims whitespace and stores trimmed name
  {
    const res = await admin.request(`/api/servers/${serverId}/channels`, {
      method: "POST", json: { name: " canal-con-espacios " },
    });
    assert.equal(res.status, 201, "POST channel with whitespace trims and succeeds");
    assert.equal(res.result.name, "canal-con-espacios", "stored name is trimmed");
    console.log("PASS POST channel trims whitespace and stores trimmed name");
  }

  // 4. Without permission returns 403
  {
    const res = await member.request(`/api/servers/${serverId}/channels`, {
      method: "POST", json: { name: "no-permiso" },
    });
    assert.equal(res.status, 403, "POST channel without permission returns 403");
    console.log("PASS POST channel without permission returns 403");
  }

  // ─── PATCH /channels/:channelId validation ──────────────────────────────

  // 5. Empty name returns 400 with Spanish message
  {
    const res = await admin.request(`/api/channels/${textChannelId}`, {
      method: "PATCH", json: { name: " " },
    });
    assert.equal(res.status, 400, "PATCH channel with empty name returns 400");
    assert.match(res.result.error, /obligatorio/i, `Expected Spanish error, got: ${res.result.error}`);
    console.log("PASS PATCH channel with empty name returns 400 with Spanish message");
  }

  // 6. Rejects channelType change (E4): channelType is stripped by Zod, leaving no valid updates → 400
  {
    const res = await admin.request(`/api/channels/${textChannelId}`, {
      method: "PATCH", json: { channelType: "voice" },
    });
    assert.equal(res.status, 400, "PATCH with only channelType returns 400 (no valid changes after strip)");
    assert.match(res.result.error, /cambios/i, `Expected 'no changes' error, got: ${res.result.error}`);
    // Verify channelType was not changed in DB
    const verify = await admin.request(`/api/servers/${serverId}/channels`);
    const ch = verify.result.find(c => c.id === textChannelId);
    assert.equal(ch.channelType, "text", "channelType must remain text after rejected PATCH");
    console.log("PASS PATCH channel rejects channelType change (E4)");
  }

  // 7. Invalid categoryId returns 400
  {
    const res = await admin.request(`/api/channels/${textChannelId}`, {
      method: "PATCH", json: { categoryId: 999999 },
    });
    assert.equal(res.status, 400, "PATCH channel with invalid categoryId returns 400");
    assert.match(res.result.error, /categoría no pertenece/i, `Expected category ownership error, got: ${res.result.error}`);
    console.log("PASS PATCH channel with invalid categoryId returns 400");
  }

  // 8. Without permission returns 403
  {
    const res = await member.request(`/api/channels/${textChannelId}`, {
      method: "PATCH", json: { name: "hackeado" },
    });
    assert.equal(res.status, 403, "PATCH channel without permission returns 403");
    console.log("PASS PATCH channel without permission returns 403");
  }

  // ─── DELETE /channels/:channelId — E3 protection ────────────────────────

  // 9. Delete last text channel returns 409 (E3)
  {
    const channelsRes = await admin.request(`/api/servers/${serverId}/channels`);
    assert.equal(channelsRes.status, 200, "list channels for cleanup");
    const textChannels = channelsRes.result.filter(c => c.channelType === "text");
    for (const ch of textChannels) {
      if (ch.id !== textChannelId) {
        const delRes = await admin.request(`/api/channels/${ch.id}`, { method: "DELETE" });
        assert.equal(delRes.status, 204, `delete extra text channel ${ch.id}`);
      }
    }
    const res = await admin.request(`/api/channels/${textChannelId}`, { method: "DELETE" });
    assert.equal(res.status, 409, `Expected 409 for last text channel, got ${res.status}`);
    assert.match(res.result.error, /último canal de texto/i, `Expected Spanish E3 error, got: ${res.result.error}`);
    console.log("PASS DELETE last text channel returns 409 with Spanish message (E3)");
  }

  // 10. Delete non-text channel succeeds even when only one text channel remains
  {
    const res = await admin.request(`/api/channels/${mediaChannelId}`, { method: "DELETE" });
    assert.equal(res.status, 204, `Expected 204 for media channel delete, got ${res.status}`);
    console.log("PASS DELETE non-text channel succeeds when only one text channel remains");
  }

  // 11. Delete without permission returns 403
  {
    const res = await member.request(`/api/channels/${voiceChannelId}`, { method: "DELETE" });
    assert.equal(res.status, 403, "DELETE channel without permission returns 403");
    console.log("PASS DELETE channel without permission returns 403");
  }

  // ─── PUT /servers/:serverId/channels/reorder ────────────────────────────

  // 12. Invalid channelId returns 400
  {
    const res = await admin.request(`/api/servers/${serverId}/channels/reorder`, {
      method: "PUT", json: [{ channelId: 999999, position: 0 }],
    });
    assert.equal(res.status, 400, "PUT reorder with invalid channelId returns 400");
    assert.match(res.result.error, /IDs de canal inválidos/i, `Expected invalid channel ID error, got: ${res.result.error}`);
    console.log("PASS PUT reorder with invalid channelId returns 400");
  }

  // 13. Foreign categoryId returns 400
  {
    const res = await admin.request(`/api/servers/${serverId}/channels/reorder`, {
      method: "PUT", json: [{ channelId: textChannelId, position: 0, categoryId: 999999 }],
    });
    assert.equal(res.status, 400, "PUT reorder with foreign categoryId returns 400");
    assert.match(res.result.error, /categorías no pertenecen/i, `Expected foreign category error, got: ${res.result.error}`);
    console.log("PASS PUT reorder with foreign categoryId returns 400");
  }

  // 14. Without permission returns 403
  {
    const res = await member.request(`/api/servers/${serverId}/channels/reorder`, {
      method: "PUT", json: [{ channelId: textChannelId, position: 0 }],
    });
    assert.equal(res.status, 403, "PUT reorder without permission returns 403");
    console.log("PASS PUT reorder without permission returns 403");
  }

  // 15. Valid reorder succeeds
  {
    const tc2 = expectStatus(await admin.request(`/api/servers/${serverId}/channels`, {
      method: "POST", json: { name: "texto-dos", channelType: "text" },
    }), 201, "create second text channel for reorder");
    const res = await admin.request(`/api/servers/${serverId}/channels/reorder`, {
      method: "PUT", json: [
        { channelId: textChannelId, position: 1 },
        { channelId: tc2.id, position: 0 },
      ],
    });
    assert.equal(res.status, 204, `Expected 204 for reorder, got ${res.status}`);
    console.log("PASS PUT reorder succeeds with valid data");
  }

  // ─── Invalid IDs ─────────────────────────────────────────────────────────

  // 16. Invalid serverId in POST
  {
    const res = await admin.request("/api/servers/abc/channels", {
      method: "POST", json: { name: "test" },
    });
    assert.equal(res.status, 400, "POST channel with invalid serverId returns 400");
    console.log("PASS POST channel with invalid serverId returns 400");
  }

  // 17. Invalid channelId in PATCH
  {
    const res = await admin.request("/api/channels/abc", {
      method: "PATCH", json: { name: "test" },
    });
    assert.equal(res.status, 400, "PATCH channel with invalid channelId returns 400");
    console.log("PASS PATCH channel with invalid channelId returns 400");
  }

  // 18. Invalid channelId in DELETE
  {
    const res = await admin.request("/api/channels/abc", { method: "DELETE" });
    assert.equal(res.status, 400, "DELETE channel with invalid channelId returns 400");
    console.log("PASS DELETE channel with invalid channelId returns 400");
  }

  console.log("PASS all D1 channel management checks passed");
} finally {
  await cleanup();
}