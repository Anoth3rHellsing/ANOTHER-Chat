// Isolated auth/session/CSRF and message-encryption regression coverage.
// PostgreSQL, API working directory, sessions, and all data are disposable /tmp assets.
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
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

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

async function expectStartupFailure(bundle, env, label) {
  const child = spawn(process.execPath, [bundle], {
    cwd: path.join(tempRoot, "api"),
    env,
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  let timer;
  const result = await Promise.race([
    exited.then(([code, signal]) => ({ code, signal })),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), 8_000); }),
  ]);
  clearTimeout(timer);
  if (result === null) {
    child.kill("SIGTERM");
    await exited;
    assert.fail(`${label}: API did not fail startup`);
  }
  assert.notEqual(result.code, 0, `${label}: API must exit unsuccessfully`);
  console.log(`PASS ${label} (exit ${result.code ?? result.signal})`);
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
  assert.equal(os.tmpdir(), "/tmp", "this test requires all disposable data under /tmp");
  pgBin = postgresBinDirectory();
  assert.ok(pgBin, "PostgreSQL 16 tools are required");
  const postgresVersion = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(postgresVersion, /PostgreSQL\) 16\b/, `Expected PostgreSQL 16, got ${postgresVersion.trim()}`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "auth-crypto-isolated-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await freePort();
  apiPort = await freePort();
  const pgUser = os.userInfo().username;
  databaseName = `auth_crypto_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
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

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const username = `crypto_admin_${suffix}`;
  const password = `Disposable-${randomUUID()}!`;
  const admin = account(base);
  const registered = expectStatus(await admin.request("/api/auth/register", {
    method: "POST",
    json: { username, password, displayName: "Disposable crypto administrator" },
  }), 201, "register the first account without a CSRF token");
  assert.equal(registered.role, "admin", "the first account is a global admin");
  const generalOwner = sql("SELECT owner_id FROM servers WHERE is_general = true", env, true);
  assert.equal(generalOwner, String(registered.id), "the first account owns the General server");
  const generalMembership = sql(
    `SELECT role FROM server_members WHERE server_id = (SELECT id FROM servers WHERE is_general = true) AND user_id = ${registered.id}`,
    env,
    true,
  );
  assert.equal(generalMembership, "owner", "the first account has owner membership in General");
  console.log("PASS first registration creates the General server owned by its global admin");

  const guest = account(base);
  expectStatus(await guest.request("/api/auth/login", {
    method: "POST", json: { username, password: "wrong-password" },
  }), 401, "reject an incorrect password without CSRF");
  const loggedIn = expectStatus(await guest.request("/api/auth/login", {
    method: "POST", json: { username, password },
  }), 200, "allow a correct login without CSRF");
  assert.equal(loggedIn.id, registered.id);
  assert.ok(guest.cookies.has("connect.sid"), "login returns a signed session cookie");
  assert.ok(guest.cookies.has("csrf_token"), "login issues a CSRF token");
  expectStatus(await guest.request("/api/auth/me"), 200, "authenticate a second request with the persistent login cookie");
  const sameSessionClient = account(base);
  sameSessionClient.cookies.set("connect.sid", guest.cookies.get("connect.sid"));
  expectStatus(await sameSessionClient.request("/api/auth/me"), 200, "reuse the persisted session cookie in a new client");

  const csrfBefore = guest.cookies.get("csrf_token");
  guest.cookies.delete("csrf_token");
  expectStatus(await guest.request("/api/auth/me"), 200, "/auth/me re-emits the existing CSRF token");
  assert.equal(guest.cookies.get("csrf_token"), csrfBefore,
    "/auth/me reissues the session's existing CSRF value rather than rotating it");

  const signedCookie = guest.cookies.get("connect.sid");
  const tamperedCookie = `${signedCookie.slice(0, -1)}${signedCookie.endsWith("a") ? "b" : "a"}`;
  expectStatus(await account(base).request("/api/auth/me", {
    cookieHeader: `connect.sid=${tamperedCookie}`,
  }), 401, "deny a tampered signed session cookie");

  const second = account(base);
  const secondName = `crypto_member_${suffix}`;
  const noInvite = await second.request("/api/auth/register", {
    method: "POST",
    json: { username: secondName, password, displayName: "Disposable invited member" },
  });
  expectStatus(noInvite, 400, "require an invite for subsequent registration");
  assert.match(noInvite.result.error, /invitación/i);

  const invite = expectStatus(await guest.request("/api/admin/invites", {
    method: "POST", json: {},
  }), 201, "create an invite using an admin session and valid CSRF token");
  const member = expectStatus(await second.request("/api/auth/register", {
    method: "POST",
    json: { username: secondName, password, displayName: "Disposable invited member", inviteCode: invite.code },
  }), 201, "allow invite registration without a CSRF token");
  assert.equal(member.role, "member");
  const generalMemberRole = sql(
    `SELECT role FROM server_members WHERE server_id = (SELECT id FROM servers WHERE is_general = true) AND user_id = ${member.id}`,
    env,
    true,
  );
  assert.equal(generalMemberRole, "member", "subsequent user joins General as a member");

  // A valid authenticated session must not bypass the CSRF cookie/header/session triple check.
  expectStatus(await guest.request("/api/servers", {
    method: "POST", json: { name: "CSRF disposable server" }, csrf: "omit",
  }), 403, "reject a protected mutation with no CSRF header");
  expectStatus(await guest.request("/api/servers", {
    method: "POST", json: { name: "CSRF disposable server" }, csrf: "wrong",
  }), 403, "reject a protected mutation with an incorrect CSRF header");
  const server = expectStatus(await guest.request("/api/servers", {
    method: "POST", json: { name: "CSRF disposable server" }, csrf: "valid",
  }), 201, "allow a protected mutation with the matching CSRF cookie and header");
  const channel = expectStatus(await guest.request(`/api/servers/${server.id}/channels`, {
    method: "POST", json: { name: "crypto-regression", channelType: "text" },
  }), 201, "create a private disposable channel for encryption coverage");

  const sentText = `authenticated-roundtrip-${suffix}`;
  const sent = expectStatus(await guest.request(`/api/channels/${channel.id}/messages`, {
    method: "POST", json: { content: sentText },
  }), 201, "store an authenticated-encryption message through the API");
  const stored = sql(
    `SELECT content_encrypted || '|' || iv FROM messages WHERE id = ${sent.id}`,
    env,
    true,
  );
  const [storedEnvelope, storedIv] = stored.split("|");
  assert.ok(storedEnvelope.startsWith("gcm:v1:"), "new message storage uses versioned AES-GCM");
  assert.equal(storedIv.length, 24, "AES-GCM message IV is 12 bytes");
  const roundTrip = expectStatus(await guest.request(
    `/api/channels/${channel.id}/search?q=${encodeURIComponent(sentText)}`,
  ), 200, "decrypt and search the stored AES-GCM message");
  assert.ok(roundTrip.some(message => message.id === sent.id && message.content === sentText),
    "authenticated ciphertext round-trips to the exact plaintext");

  const key = Buffer.from(env.MESSAGE_ENCRYPTION_KEY, "hex");
  const legacyIv = randomBytes(16);
  const legacyCipher = createCipheriv("aes-256-cbc", key, legacyIv);
  const legacyText = `legacy-cbc-migrate-${suffix}`;
  const legacyEncrypted = Buffer.concat([
    legacyCipher.update(legacyText, "utf8"),
    legacyCipher.final(),
  ]).toString("hex");
  const legacyId = Number(sql(
    `INSERT INTO messages (channel_id, user_id, content_encrypted, iv) VALUES (${channel.id}, ${registered.id}, ${quoteSql(legacyEncrypted)}, ${quoteSql(legacyIv.toString("hex"))}) RETURNING id`,
    env,
    true,
  ));
  const legacyResults = expectStatus(await guest.request(
    `/api/channels/${channel.id}/search?q=${encodeURIComponent(legacyText)}`,
  ), 200, "read and lazily migrate a legacy CBC message");
  assert.ok(legacyResults.some(message => message.id === legacyId && message.content === legacyText),
    "legacy CBC plaintext is readable");
  const migrated = sql(
    `SELECT content_encrypted || '|' || iv FROM messages WHERE id = ${legacyId}`,
    env,
    true,
  );
  assert.ok(migrated.startsWith("gcm:v1:"), "successful CBC read replaces its row with authenticated GCM ciphertext");

  const tamperedEnvelope = `${storedEnvelope.slice(0, -1)}${storedEnvelope.endsWith("0") ? "1" : "0"}`;
  const unreadableId = Number(sql(
    `INSERT INTO messages (channel_id, user_id, content_encrypted, iv) VALUES (${channel.id}, ${registered.id}, ${quoteSql(tamperedEnvelope)}, ${quoteSql(storedIv)}) RETURNING id`,
    env,
    true,
  ));
  const unreadableBefore = sql(
    `SELECT content_encrypted || '|' || iv FROM messages WHERE id = ${unreadableId}`,
    env,
    true,
  );
  const tamperedSearch = expectStatus(await guest.request(
    `/api/channels/${channel.id}/search?q=${encodeURIComponent(sentText)}`,
  ), 200, "ignore a message whose authenticated encryption was tampered");
  assert.ok(!tamperedSearch.some(message => message.id === unreadableId),
    "tampered authenticated ciphertext is not returned as readable content");
  const unreadableAfter = sql(
    `SELECT content_encrypted || '|' || iv FROM messages WHERE id = ${unreadableId}`,
    env,
    true,
  );
  assert.equal(unreadableAfter, unreadableBefore,
    "an unreadable/tampered ciphertext row remains byte-for-byte unchanged");
  console.log("PASS authenticated AES-GCM tampering is rejected and unreadable ciphertext is not overwritten");

  for (const [label, encryptionKey] of [
    ["missing MESSAGE_ENCRYPTION_KEY", undefined],
    ["invalid MESSAGE_ENCRYPTION_KEY", "not-a-64-character-hex-key"],
  ]) {
    const childPort = await freePort();
    const childEnv = { ...isolatedEnvironment(databaseUrl, childPort) };
    if (encryptionKey === undefined) delete childEnv.MESSAGE_ENCRYPTION_KEY;
    else childEnv.MESSAGE_ENCRYPTION_KEY = encryptionKey;
    await expectStartupFailure(bundle, childEnv, `fail startup with ${label}`);
  }
} finally {
  await cleanup();
}