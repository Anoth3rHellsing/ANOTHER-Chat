// Isolated full-stack event-route verification. All PostgreSQL files and
// temporary test output live under a disposable directory in /tmp.
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
import WebSocket from "ws";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(apiRoot, "../..");
const databaseRoot = path.join(repoRoot, "lib/db");
const apiPort = 4012;
const base = `http://127.0.0.1:${apiPort}`;
const apiRequire = createRequire(path.join(apiRoot, "package.json"));
const { build } = apiRequire("esbuild");
const esbuildPluginPino = apiRequire("esbuild-plugin-pino");

let tempRoot;
let pgBin;
let pgData;
let pgPort;
let apiProcess;
let apiExit;
let creatorWs;
let memberWs;
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

function isolatedEnvironment(databaseUrl) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete env[key];
    }
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

function account() {
  const cookies = new Map();
  return {
    cookies,
    async request(url, { method = "GET", json } = {}) {
      const headers = {};
      if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      if (cookies.has("csrf_token") && method !== "GET" && method !== "HEAD") {
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
      return { status: response.status, result };
    },
  };
}

function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.result)}`);
  console.log(`PASS ${label} (${status})`);
  return response.result;
}

function waitFor(ws, predicate, label, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeout);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(message);
    }
    ws.on("message", onMessage);
  });
}

async function connect(accountClient) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", {
    headers: { Cookie: [...accountClient.cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
  });
  const connected = waitFor(ws, message => message.type === "connected", "WS authenticated connection");
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await connected;
  return ws;
}

function parseId(object, field, label) {
  const value = object?.[field];
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
}

async function pollApiReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      const response = await fetch(`${base}/api/auth/me`);
      if (response.status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error("Isolated API did not become ready");
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
  creatorWs?.terminate();
  memberWs?.terminate();

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
  await assertPortFree(apiPort);
  pgBin = postgresBinDirectory();
  if (!pgBin) throw new Error("PostgreSQL 16 initdb/pg_ctl/createdb/psql binaries are unavailable");
  const version = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(version, /PostgreSQL\) 16\b/, `Expected PostgreSQL 16, got ${version.trim()}`);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "events-integration-"));
  pgData = path.join(tempRoot, "postgres-data");
  const logPath = path.join(tempRoot, "postgres.log");
  pgPort = await reserveFreePort();
  const database = `events_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const pgUser = os.userInfo().username;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${database}`;
  const env = isolatedEnvironment(databaseUrl);

  run(path.join(pgBin, "initdb"), [
    "-D", pgData, "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust",
  ], { env });
  run(path.join(pgBin, "pg_ctl"), [
    "-D", pgData, "-l", logPath, "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${tempRoot}`,
    "-w", "start",
  ], { env });
  pgStarted = true;
  run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, database], { env });

  const migration = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"], {
    cwd: databaseRoot,
    env,
    encoding: "utf8",
  });
  if (migration.error || migration.status !== 0) {
    throw new Error(`Full versioned Drizzle migration chain failed (${migration.error?.message ?? `exit ${migration.status}`})`);
  }
  console.log("PASS full versioned migration chain applied to empty temporary PostgreSQL 16 database");

  const bundle = await buildApiIntoTemp();
  apiProcess = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  apiExit = once(apiProcess, "exit");
  await pollApiReady();
  console.log("PASS current API source built in /tmp and serving on isolated port 4012");

  const admin = account();
  const creator = account();
  const member = account();
  const outsider = account();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const adminPassword = `Disposable-${randomUUID()}!`;
  const creatorPassword = `Disposable-${randomUUID()}!`;
  const memberPassword = `Disposable-${randomUUID()}!`;
  const outsiderPassword = `Disposable-${randomUUID()}!`;
  const adminName = `event_admin_${suffix}`;
  const creatorName = `event_creator_${suffix}`;
  const memberName = `event_member_${suffix}`;
  const outsiderName = `event_outside_${suffix}`;

  expectStatus(await admin.request("/api/auth/register", { method: "POST", json: {
    username: adminName, password: adminPassword, displayName: "Temporary Event Admin",
  } }), 201, "register isolated global admin");
  const adminLogin = expectStatus(await admin.request("/api/auth/login", {
    method: "POST", json: { username: adminName, password: adminPassword },
  }), 200, "normal HTTP login for isolated global admin");
  assert.equal(adminLogin.role, "admin");
  const creatorInvite = expectStatus(await admin.request("/api/admin/invites", { method: "POST", json: {} }),
    201, "create disposable registration invite for creator");
  const memberInvite = expectStatus(await admin.request("/api/admin/invites", { method: "POST", json: {} }),
    201, "create disposable registration invite for member");
  const outsiderInvite = expectStatus(await admin.request("/api/admin/invites", { method: "POST", json: {} }),
    201, "create disposable registration invite for outsider");

  expectStatus(await creator.request("/api/auth/register", { method: "POST", json: {
    username: creatorName, password: creatorPassword, displayName: "Temporary Creator",
    inviteCode: creatorInvite.code,
  } }), 201, "register synthetic event creator");
  expectStatus(await creator.request("/api/auth/login", {
    method: "POST", json: { username: creatorName, password: creatorPassword },
  }), 200, "normal HTTP login for creator");
  expectStatus(await member.request("/api/auth/register", { method: "POST", json: {
    username: memberName, password: memberPassword, displayName: "Temporary Member",
    inviteCode: memberInvite.code,
  } }), 201, "register synthetic server member");
  expectStatus(await member.request("/api/auth/login", {
    method: "POST", json: { username: memberName, password: memberPassword },
  }), 200, "normal HTTP login for member");
  expectStatus(await outsider.request("/api/auth/register", { method: "POST", json: {
    username: outsiderName, password: outsiderPassword, displayName: "Temporary Outsider",
    inviteCode: outsiderInvite.code,
  } }), 201, "register third synthetic outsider");
  expectStatus(await outsider.request("/api/auth/login", {
    method: "POST", json: { username: outsiderName, password: outsiderPassword },
  }), 200, "normal HTTP login for outsider");

  const server = expectStatus(await creator.request("/api/servers", {
    method: "POST", json: { name: "Temporary Events Integration Server" },
  }), 201, "create disposable test server");
  const serverId = parseId(server, "id", "server id");
  const serverInvite = expectStatus(await creator.request(`/api/servers/${serverId}/invites`, {
    method: "POST", json: {},
  }), 201, "create disposable server invite");
  expectStatus(await member.request("/api/servers/join-by-invite", {
    method: "POST", json: { code: serverInvite.code },
  }), 200, "member joins disposable server");
  const adminServerInvite = expectStatus(await creator.request(`/api/servers/${serverId}/invites`, {
    method: "POST", json: {},
  }), 201, "create disposable server invitation for administrator");
  expectStatus(await admin.request("/api/servers/join-by-invite", {
    method: "POST", json: { code: adminServerInvite.code },
  }), 200, "administrator joins disposable server");
  expectStatus(await creator.request(`/api/servers/${serverId}/members/${adminLogin.id}/role`, {
    method: "PATCH", json: { role: "admin" },
  }), 200, "creator assigns the temporary account the server-admin role");
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, "-d", database,
    "-X", "-q", "-v", "ON_ERROR_STOP=1",
    "-c", `UPDATE users SET role = 'member' WHERE id = ${adminLogin.id}`,
  ], { env });
  const serverAdminLogin = expectStatus(await admin.request("/api/auth/login", {
    method: "POST", json: { username: adminName, password: adminPassword },
  }), 200, "refresh normal login with the server-only administrator role");
  assert.equal(serverAdminLogin.role, "member",
    "the event-management check must exercise server membership admin, not global admin");
  const channel = expectStatus(await creator.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "events-integration", channelType: "text" },
  }), 201, "create disposable text channel");
  const channelId = parseId(channel, "id", "channel id");

  creatorWs = await connect(creator);
  memberWs = await connect(member);
  creatorWs.send(JSON.stringify({ type: "subscribe", channel: `channel:${channelId}` }));
  memberWs.send(JSON.stringify({ type: "subscribe", channel: `channel:${channelId}` }));
  await new Promise(resolve => setTimeout(resolve, 100));

  const now = Date.now();
  const startsAt = new Date(now + 40 * 24 * 60 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 90 * 60 * 1000);
  const withOffset = date => `${new Date(date.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, -1)}+05:30`;
  const inputStart = withOffset(startsAt);
  const inputEnd = withOffset(endsAt);
  const event = expectStatus(await creator.request(`/api/channels/${channelId}/events`, {
    method: "POST", json: {
      title: "UTC Event Round Trip",
      description: "synthetic event fixture",
      startsAt: inputStart,
      endsAt: inputEnd,
      originalTimeZone: "Asia/Kolkata",
    },
  }), 201, "create event with explicit UTC-offset timestamps");
  const eventId = parseId(event, "id", "event id");
  assert.equal(new Date(event.startsAt).toISOString(), startsAt.toISOString());
  assert.equal(new Date(event.endsAt).toISOString(), endsAt.toISOString());
  assert.equal(event.originalTimeZone, "Asia/Kolkata");
  console.log("PASS event timestamps round-trip as the same UTC instants");

  const channelMessages = expectStatus(await creator.request(`/api/channels/${channelId}/messages`),
    200, "read persisted channel messages");
  const announcement = `Nueva actividad: UTC Event Round Trip\n[event:${eventId}]`;
  assert.ok(channelMessages.some(message => message.content === announcement),
    "event create must persist its normal, decryptable channel announcement message");
  console.log("PASS event creation persists the normal readable channel announcement");

  expectStatus(await outsider.request(`/api/channels/${channelId}/events`),
    403, "outsider cannot list events in a private server channel");
  expectStatus(await outsider.request(`/api/channels/${channelId}/events/${eventId}`),
    403, "outsider cannot read event detail");
  expectStatus(await outsider.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "yes" },
  }), 403, "outsider cannot RSVP");
  expectStatus(await member.request(`/api/channels/${channelId}/events/${eventId}`, {
    method: "PATCH", json: { title: "Member must not edit" },
  }), 403, "member cannot edit creator event");
  expectStatus(await member.request(`/api/channels/${channelId}/events/${eventId}`, {
    method: "DELETE",
  }), 403, "member cannot cancel creator event");

  const rsvpFromPeer = waitFor(creatorWs, message =>
    message.type === "event:rsvp_updated" && message.data?.eventId === eventId,
  "RSVP broadcast to another user's existing WebSocket");
  let state = expectStatus(await member.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "yes" },
  }), 200, "member RSVPs yes");
  await rsvpFromPeer;
  assert.equal(state.counts.yes, 1);
  console.log("PASS RSVP update reaches the creator's already-open subscribed WebSocket");

  state = expectStatus(await member.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "no" },
  }), 200, "member changes RSVP from yes to no");
  assert.deepEqual(state.counts, { yes: 0, no: 1, maybe: 0 });
  assert.equal(state.responses.filter(response => response.userId === state.myResponse.userId).length, 1);
  expectStatus(await admin.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "maybe" },
  }), 200, "server-wide admin RSVPs maybe");
  state = expectStatus(await creator.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "yes" },
  }), 200, "creator RSVPs yes");
  assert.deepEqual(state.counts, { yes: 1, no: 1, maybe: 1 });
  assert.equal(state.responses.length, 3, "upserted RSVP is unique per event and user");
  console.log("PASS yes/no/maybe responses upsert uniquely and recount correctly");

  expectStatus(await member.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "maybe" },
  }), 200, "member selects maybe before reschedule notice");
  const creatorEdit = expectStatus(await creator.request(`/api/channels/${channelId}/events/${eventId}`, {
    method: "PATCH", json: { title: "Creator Edited Event" },
  }), 200, "creator edits own event");
  assert.equal(creatorEdit.title, "Creator Edited Event");
  const shiftedStart = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
  const shiftedEnd = new Date(endsAt.getTime() + 2 * 60 * 60 * 1000);
  const rescheduleNotice = waitFor(memberWs, message =>
    message.type === "event:rescheduled" && message.data?.eventId === eventId,
  "targeted reschedule notification to member");
  const rescheduled = expectStatus(await creator.request(`/api/channels/${channelId}/events/${eventId}`, {
    method: "PATCH", json: {
      startsAt: shiftedStart.toISOString(), endsAt: shiftedEnd.toISOString(),
    },
  }), 200, "creator changes event schedule");
  assert.equal(new Date(rescheduled.startsAt).toISOString(), shiftedStart.toISOString());
  assert.deepEqual(rescheduled.counts, { yes: 0, no: 0, maybe: 0 });
  assert.equal(rescheduled.responses.length, 0, "schedule change resets every response");
  assert.equal((await rescheduleNotice).data.channelId, channelId);
  console.log("PASS event schedule edits clear all prior RSVPs and notify interested members");

  const afterReschedule = expectStatus(await member.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "yes" },
  }), 200, "member makes a new RSVP after schedule reset");
  assert.equal(afterReschedule.counts.yes, 1);
  const cancelNotice = waitFor(memberWs, message =>
    message.type === "event:attendee_cancelled" && message.data?.eventId === eventId,
  "targeted cancellation notification to member");
  const canceled = expectStatus(await creator.request(`/api/channels/${channelId}/events/${eventId}`, {
    method: "DELETE",
  }), 200, "creator soft-cancels own event");
  assert.ok(canceled.canceledAt, "creator cancellation must retain a canceled-at audit timestamp");
  assert.equal(canceled.responses.length, 1, "cancellation must retain RSVP audit rows");
  assert.equal((await cancelNotice).data.channelId, channelId);
  console.log("PASS creator cancellation keeps RSVP audit data and notifies affected members");

  const adminEvent = expectStatus(await creator.request(`/api/channels/${channelId}/events`, {
    method: "POST", json: {
      title: "Admin Managed Event",
      startsAt: new Date(Date.now() + 50 * 24 * 60 * 60 * 1000).toISOString(),
      originalTimeZone: "UTC",
    },
  }), 201, "create second disposable event for administrator authorization checks");
  const adminEventId = parseId(adminEvent, "id", "admin event id");
  const adminEdit = expectStatus(await admin.request(`/api/channels/${channelId}/events/${adminEventId}`, {
    method: "PATCH", json: { title: "Admin Edited Event" },
  }), 200, "server administrator edits event");
  assert.equal(adminEdit.title, "Admin Edited Event");
  const adminCanceled = expectStatus(await admin.request(`/api/channels/${channelId}/events/${adminEventId}`, {
    method: "DELETE",
  }), 200, "server administrator cancels event");
  assert.ok(adminCanceled.canceledAt);
  console.log("PASS server administrator can edit and cancel events");

  const extraResponse = await member.request(`/api/channels/${channelId}/events/${eventId}/response`, {
    method: "PUT", json: { status: "maybe" },
  });
  expectStatus(extraResponse, 409, "canceled event rejects further RSVPs");
  const channelDelete = await creator.request(`/api/channels/${channelId}`, { method: "DELETE" });
  expectStatus(channelDelete, 204, "delete disposable channel");

  const sql = statement => run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, "-d", database,
    "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", statement,
  ], { env }).trim();
  assert.equal(sql(`SELECT count(*) FROM channel_events WHERE channel_id = ${channelId}`), "0");
  assert.equal(sql(`SELECT count(*) FROM event_responses WHERE event_id IN (${eventId}, ${adminEventId})`), "0");
  console.log("PASS channel DELETE cascades through all events and event responses");

  complete = true;
} finally {
  try {
    await cleanup();
  } catch (error) {
    if (complete) throw error;
    console.error(`CLEANUP FAILURE: ${error.message}`);
  }
}

if (!complete) throw new Error("Isolated event integration verification did not complete");
console.log("PASS isolated PostgreSQL cluster and API process stopped; /tmp fixture removed");
console.log("PASS exercised: current built API app, auth login/session/CSRF, channel events REST, channel messages REST, HTTP authorization, WebSocket event broadcast, Drizzle migration chain, event/message/response PostgreSQL persistence, channel deletion cascade");