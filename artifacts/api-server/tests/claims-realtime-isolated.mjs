// Disposable PostgreSQL integration coverage for channel access, attachment
// claims, and connection-scoped realtime behavior.
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
const apiRequire = createRequire(path.join(apiRoot, "package.json"));
const { build } = apiRequire("esbuild");
const esbuildPluginPino = apiRequire("esbuild-plugin-pino");

let tempRoot;
let pgBin;
let pgData;
let pgPort;
let apiPort;
let apiBase;
let apiProcess;
let apiExit;
let pgStarted = false;
const sockets = new Set();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${path.basename(command)} ${args[0] ?? ""} failed (${result.error?.message ?? `exit ${result.status}`})\n${result.stderr ?? ""}`,
    );
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
    ["initdb", "pg_ctl", "createdb", "psql", "postgres"].every(binary => existsSync(path.join(dir, binary))),
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

function isolatedEnvironment(databaseUrl) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete env[key];
    }
    if (/^GIPHY/i.test(key)) delete env[key];
  }
  delete env.Giphy;
  delete env.REPLIT_DEV_DOMAIN;
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    MESSAGE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    NODE_ENV: "development",
    LOG_LEVEL: "fatal",
    PORT: String(apiPort),
    APP_URL: `http://127.0.0.1:${apiPort}`,
  };
}

function account() {
  const cookies = new Map();
  return {
    cookies,
    async request(url, { method = "GET", json, body, headers: extraHeaders = {} } = {}) {
      const headers = { ...extraHeaders };
      if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
      if (cookies.has("csrf_token") && method !== "GET" && method !== "HEAD") {
        headers["x-csrf-token"] = cookies.get("csrf_token");
      }
      let requestBody = body;
      if (json !== undefined) {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(json);
      }
      const response = await fetch(`${apiBase}${url}`, { method, headers, body: requestBody });
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

function waitFor(ws, predicate, label, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const existing = ws.messageHistory?.find(predicate);
    if (existing) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
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

function cookieHeader(client) {
  return [...client.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function openSocket(client, { pendingMessages = [] } = {}) {
  const ws = new WebSocket(apiBase.replace(/^http/, "ws") + "/ws", {
    headers: client ? { Cookie: cookieHeader(client) } : {},
  });
  sockets.add(ws);
  ws.messageHistory = [];
  ws.on("message", raw => {
    try { ws.messageHistory.push(JSON.parse(raw.toString())); } catch {}
  });
  const connected = client
    ? waitFor(ws, message => message.type === "connected", "authenticated WebSocket")
    : null;
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await opened;
  for (const message of pendingMessages) ws.send(JSON.stringify(message));
  if (connected) await connected;
  return ws;
}

async function connect(client) {
  return openSocket(client);
}

function parseId(object, field, label) {
  const value = object?.[field];
  assert.ok(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
  return value;
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
      js: `import { createRequire as __cr } from "node:module";
import __path from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
globalThis.require=__cr(import.meta.url);
globalThis.__filename=__fileURLToPath(import.meta.url);
globalThis.__dirname=__path.dirname(globalThis.__filename);`,
    },
  });
  return path.join(outDir, "index.mjs");
}

async function waitForApiReady() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      if ((await fetch(`${apiBase}/api/auth/me`)).status === 401) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Isolated API did not become ready");
}

async function uploadAttachment(client, channelId, filename) {
  const form = new FormData();
  form.append("file", new Blob([`synthetic disposable attachment ${filename}`], { type: "text/plain" }), filename);
  return expectStatus(await client.request(`/api/channels/${channelId}/attachments`, {
    method: "POST", body: form,
  }), 201, `upload ${filename} to channel ${channelId}`);
}

async function cleanup() {
  for (const ws of sockets) ws.terminate();
  if (apiProcess?.exitCode === null && apiProcess?.signalCode === null) {
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
  assert.equal(os.tmpdir(), "/tmp", "this test requires disposable data under /tmp");
  pgBin = postgresBinDirectory();
  assert.ok(pgBin, "PostgreSQL 16 tools are required");
  assert.match(run(path.join(pgBin, "postgres"), ["--version"]), /PostgreSQL\) 16\b/);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "claims-realtime-isolated-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await freePort();
  apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  const pgUser = os.userInfo().username;
  const databaseName = `claims_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${databaseName}`;
  const env = isolatedEnvironment(databaseUrl);

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
    throw new Error(`Fresh disposable database migrations failed (${migration.error?.message ?? `exit ${migration.status}`})\n${migration.stderr ?? ""}`);
  }
  console.log("PASS complete migration chain applied to fresh disposable PostgreSQL 16");

  const bundle = await buildApiIntoTemp();
  const apiCwd = path.join(tempRoot, "api");
  await mkdir(path.join(apiCwd, "uploads"), { recursive: true });
  apiProcess = spawn(process.execPath, [bundle], { cwd: apiCwd, env, stdio: ["ignore", "ignore", "ignore"] });
  apiExit = once(apiProcess, "exit");
  await waitForApiReady();
  console.log("PASS bundled API serving against isolated database and upload directory");

  const owner = account();
  const member = account();
  const peer = account();
  const outsider = account();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
  const ownerName = `claim_owner_${suffix}`;
  const memberName = `claim_member_${suffix}`;
  const peerName = `claim_peer_${suffix}`;
  const outsiderName = `claim_outsider_${suffix}`;
  const credentials = [
    [owner, ownerName], [member, memberName], [peer, peerName], [outsider, outsiderName],
  ];
  const ids = {};
  for (const [index, [client, username]] of credentials.entries()) {
    const password = `Synthetic-${randomUUID()}!`;
    const registrationBody = { username, password, displayName: `Synthetic ${username}` };
    if (index > 0) {
      const registrationInvite = expectStatus(await owner.request("/api/admin/invites", {
        method: "POST", json: {},
      }), 201, `create registration invite for ${username}`);
      registrationBody.inviteCode = registrationInvite.code;
    }
    const registration = await client.request("/api/auth/register", {
      method: "POST", json: registrationBody,
    });
    expectStatus(registration, 201, `register unique synthetic account ${username}`);
    const loggedIn = expectStatus(await client.request("/api/auth/login", {
      method: "POST", json: { username, password },
    }), 200, `log in synthetic account ${username}`);
    ids[username] = parseId(loggedIn, "id", `${username} account ID`);
  }
  const ownerId = ids[ownerName];
  const memberId = ids[memberName];

  const server = expectStatus(await owner.request("/api/servers", {
    method: "POST", json: { name: `Disposable claims server ${suffix}` },
  }), 201, "create disposable test server");
  const serverId = parseId(server, "id", "test server ID");
  for (const [client, username] of [[member, memberName], [peer, peerName], [outsider, outsiderName]]) {
    const invite = expectStatus(await owner.request(`/api/servers/${serverId}/invites`, {
      method: "POST", json: {},
    }), 201, `create disposable invite for ${username}`);
    expectStatus(await client.request("/api/servers/join-by-invite", {
      method: "POST", json: { code: invite.code },
    }), 200, `${username} joins disposable server`);
  }

  const role = expectStatus(await owner.request(`/api/servers/${serverId}/roles`, {
    method: "POST", json: { name: `restricted-${suffix}`, permissions: 0 },
  }), 201, "create role required for restricted channel");
  const roleId = parseId(role, "id", "restricted role ID");
  const restricted = expectStatus(await owner.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "restricted-claims", channelType: "text", restrictedRoles: [roleId] },
  }), 201, "create role-restricted text channel");
  const restrictedId = parseId(restricted, "id", "restricted channel ID");
  const openChannel = expectStatus(await owner.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "claims-open", channelType: "text" },
  }), 201, "create accessible attachment channel");
  const openChannelId = parseId(openChannel, "id", "open channel ID");
  const otherChannel = expectStatus(await owner.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "claims-other", channelType: "text" },
  }), 201, "create second channel for wrong-channel claim test");
  const otherChannelId = parseId(otherChannel, "id", "other channel ID");
  const voiceChannel = expectStatus(await owner.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "realtime-voice", channelType: "voice" },
  }), 201, "create disposable voice channel");
  const voiceChannelId = parseId(voiceChannel, "id", "voice channel ID");

  const deniedHistory = await member.request(`/api/channels/${restrictedId}/messages`);
  expectStatus(deniedHistory, 403, "member without required role cannot access restricted channel over HTTP");
  const deniedPost = await member.request(`/api/channels/${restrictedId}/messages`, {
    method: "POST", json: { content: "must remain inaccessible" },
  });
  expectStatus(deniedPost, 403, "member without required role cannot post to restricted channel");

  const memberWs = await connect(member);
  const memberWsSecond = await connect(member);
  const memberEvents = [];
  memberWs.on("message", raw => {
    try { memberEvents.push(JSON.parse(raw.toString())); } catch {}
  });
  memberWsSecond.on("message", raw => {
    try { memberEvents.push(JSON.parse(raw.toString())); } catch {}
  });

  const deniedWs = await connect(outsider);
  const deniedEvents = [];
  deniedWs.on("message", raw => {
    try { deniedEvents.push(JSON.parse(raw.toString())); } catch {}
  });
  const deniedMessage = waitFor(deniedWs,
    message => message.type === "error" && /acceso|access/i.test(message.message ?? ""),
    "restricted WebSocket subscription rejection");
  deniedWs.send(JSON.stringify({ type: "subscribe", channel: `channel:${restrictedId}` }));
  await deniedMessage;
  const deniedBarrier = waitFor(deniedWs, message => message.type === "pong", "restricted socket processing barrier");
  deniedWs.send(JSON.stringify({ type: "ping" }));
  await deniedBarrier;
  console.log("PASS WebSocket subscription is rejected for a member lacking the channel role");

  expectStatus(await owner.request(`/api/servers/${serverId}/members/${memberId}/roles/${roleId}`, {
    method: "POST", json: {},
  }), 200, "assign required role to member");
  expectStatus(await member.request(`/api/channels/${restrictedId}/messages`),
    200, "role assignment grants restricted channel HTTP access");

  const memberSubscriptionBarrier = waitFor(memberWs, message => message.type === "pong",
    "authorized subscription processing barrier");
  memberWs.send(JSON.stringify({ type: "subscribe", channel: `channel:${restrictedId}` }));
  memberWs.send(JSON.stringify({ type: "ping" }));
  await memberSubscriptionBarrier;
  const deniedPingBarrier = waitFor(deniedWs, message => message.type === "pong", "unauthorized delivery barrier");
  const restrictedMarker = `restricted-realtime-${suffix}`;
  const restrictedBroadcast = waitFor(memberWs, message =>
    message.type === "message:new" && message.data?.content === restrictedMarker,
  "restricted channel broadcast after role assignment");
  const posted = expectStatus(await owner.request(`/api/channels/${restrictedId}/messages`, {
    method: "POST", json: { content: restrictedMarker },
  }), 201, "post restricted-channel broadcast marker");
  assert.equal((await restrictedBroadcast).data.id, posted.id);
  deniedWs.send(JSON.stringify({ type: "ping" }));
  await deniedPingBarrier;
  assert.ok(!deniedEvents.some(message => message.type === "message:new" && message.data?.id === posted.id),
    "a denied channel subscription must not receive its broadcast");
  console.log("PASS role assignment enables HTTP and WebSocket access without leaking broadcasts to denied sockets");

  // Queue a subscription and ping immediately on socket open, before waiting
  // for the server's connected event; the queued messages must be replayed.
  const pendingWs = await openSocket(member, {
    pendingMessages: [
      { type: "subscribe", channel: `channel:${openChannelId}` },
      { type: "ping" },
    ],
  });
  const pendingPong = await waitFor(pendingWs, message => message.type === "pong",
    "queued pre-authentication ping");
  assert.equal(pendingPong.type, "pong");
  const pendingMarker = `pending-auth-replay-${suffix}`;
  const pendingBroadcast = waitFor(pendingWs, message =>
    message.type === "message:new" && message.data?.content === pendingMarker,
  "queued pre-authentication subscription broadcast");
  const pendingPost = expectStatus(await owner.request(`/api/channels/${openChannelId}/messages`, {
    method: "POST", json: { content: pendingMarker },
  }), 201, "send marker for pending-auth subscription");
  assert.equal((await pendingBroadcast).data.id, pendingPost.id);
  console.log("PASS pending authentication messages are replayed after WebSocket identity resolution");

  const invalidWs = await openSocket(null);
  const invalidAuth = await waitFor(invalidWs,
    message => message.type === "error" && message.code === "UNAUTHENTICATED",
    "explicit invalid-session WebSocket error");
  assert.match(invalidAuth.message, /autenticado/i);
  console.log("PASS invalid WebSocket session receives explicit UNAUTHENTICATED error");

  const attachment = await uploadAttachment(member, openChannelId, `uploader-${suffix}.txt`);
  const beforeNonUploader = expectStatus(await outsider.request(`/api/channels/${openChannelId}/messages`),
    200, "read open-channel history before non-uploader attempt");
  expectStatus(await outsider.request(`/api/channels/${openChannelId}/messages`, {
    method: "POST", json: { content: "", attachmentIds: [attachment.id] },
  }), 409, "another channel member cannot claim the uploader's attachment");
  const afterNonUploader = expectStatus(await outsider.request(`/api/channels/${openChannelId}/messages`),
    200, "confirm history after non-uploader claim attempt");
  assert.equal(afterNonUploader.length, beforeNonUploader.length,
    "failed uploader-only claim must not leave an empty message");

  const wrongChannelAttachment = await uploadAttachment(member, openChannelId, `wrong-channel-${suffix}.txt`);
  const beforeWrongChannel = expectStatus(await member.request(`/api/channels/${otherChannelId}/messages`),
    200, "read destination history before wrong-channel claim");
  expectStatus(await member.request(`/api/channels/${otherChannelId}/messages`, {
    method: "POST", json: { content: "", attachmentIds: [wrongChannelAttachment.id] },
  }), 409, "attachment uploaded to a different channel cannot be claimed here");
  const afterWrongChannel = expectStatus(await member.request(`/api/channels/${otherChannelId}/messages`),
    200, "confirm history after wrong-channel claim attempt");
  assert.equal(afterWrongChannel.length, beforeWrongChannel.length,
    "wrong-channel claim must not leave an empty message");

  const alreadyClaimed = await uploadAttachment(member, openChannelId, `claimed-once-${suffix}.txt`);
  const firstClaim = expectStatus(await member.request(`/api/channels/${openChannelId}/messages`, {
    method: "POST", json: { content: "", attachmentIds: [alreadyClaimed.id] },
  }), 201, "uploader claims their channel attachment");
  assert.equal(firstClaim.attachments[0]?.id, alreadyClaimed.id);
  const beforeSecondClaim = expectStatus(await member.request(`/api/channels/${openChannelId}/messages`),
    200, "read history before repeat claim");
  expectStatus(await member.request(`/api/channels/${openChannelId}/messages`, {
    method: "POST", json: { content: "", attachmentIds: [alreadyClaimed.id] },
  }), 409, "already-claimed attachment cannot be claimed again");
  const afterSecondClaim = expectStatus(await member.request(`/api/channels/${openChannelId}/messages`),
    200, "confirm history after repeat claim");
  assert.equal(afterSecondClaim.length, beforeSecondClaim.length,
    "a repeated claim must not leave an empty message");

  const concurrent = await uploadAttachment(member, openChannelId, `concurrent-${suffix}.txt`);
  const beforeConcurrent = expectStatus(await member.request(`/api/channels/${openChannelId}/messages`),
    200, "read history before concurrent attachment sends");
  const concurrentResponses = await Promise.all([
    member.request(`/api/channels/${openChannelId}/messages`, {
      method: "POST", json: { content: "", attachmentIds: [concurrent.id] },
    }),
    member.request(`/api/channels/${openChannelId}/messages`, {
      method: "POST", json: { content: "", attachmentIds: [concurrent.id] },
    }),
  ]);
  const concurrentStatuses = concurrentResponses.map(response => response.status).sort((a, b) => a - b);
  assert.deepEqual(concurrentStatuses, [201, 409],
    `exactly one concurrent empty-content claim succeeds: ${JSON.stringify(concurrentResponses.map(r => ({ status: r.status, result: r.result })))}`);
  const afterConcurrent = expectStatus(await member.request(`/api/channels/${openChannelId}/messages`),
    200, "read history after concurrent claim attempts");
  assert.equal(afterConcurrent.length, beforeConcurrent.length + 1,
    "only one message persists for concurrent attachment claims; loser leaves no empty message");
  assert.equal(afterConcurrent.filter(message =>
    message.attachments?.some(item => item.id === concurrent.id),
  ).length, 1, "one persisted message owns the concurrently claimed attachment");
  console.log("PASS uploader-only, channel-bound, single-use, and concurrent attachment claims are atomic");

  // Two authenticated sockets for one identity both subscribe to the same
  // topic. A single HTTP post must fan out to both connections.
  const fanoutBarrier1 = waitFor(memberWs, message => message.type === "pong", "first same-user subscription barrier");
  const fanoutBarrier2 = waitFor(memberWsSecond, message => message.type === "pong", "second same-user subscription barrier");
  for (const ws of [memberWs, memberWsSecond]) {
    ws.send(JSON.stringify({ type: "subscribe", channel: `channel:${openChannelId}` }));
    ws.send(JSON.stringify({ type: "ping" }));
  }
  await Promise.all([fanoutBarrier1, fanoutBarrier2]);
  const fanoutMarker = `two-connections-${suffix}`;
  const fanout1 = waitFor(memberWs, message => message.type === "message:new" && message.data?.content === fanoutMarker,
    "chat broadcast to first same-user connection");
  const fanout2 = waitFor(memberWsSecond, message => message.type === "message:new" && message.data?.content === fanoutMarker,
    "chat broadcast to second same-user connection");
  const fanoutMessage = expectStatus(await owner.request(`/api/channels/${openChannelId}/messages`, {
    method: "POST", json: { content: fanoutMarker },
  }), 201, "send chat message to multiple connections of one user");
  assert.equal((await fanout1).data.id, fanoutMessage.id);
  assert.equal((await fanout2).data.id, fanoutMessage.id);
  console.log("PASS chat broadcasts reach multiple simultaneous WebSocket connections for the same user");

  // Voice signaling is routed by (user, connection) membership rather than
  // merely by target user identity.
  const voiceJoinMember = expectStatus(await member.request(`/api/channels/${voiceChannelId}/voice/join`, {
    method: "POST",
  }), 200, "member joins disposable voice channel");
  assert.ok(voiceJoinMember.some(item => item.userId === memberId));
  const voiceJoinPeer = expectStatus(await peer.request(`/api/channels/${voiceChannelId}/voice/join`, {
    method: "POST",
  }), 200, "peer joins disposable voice channel");
  const memberBound = await connect(member);
  const memberUnbound = await connect(member);
  const peerBound = await connect(peer);
  const peerUnbound = await connect(peer);
  const boundMemberEvent = waitFor(memberBound, message => message.type === "voice:bound" &&
    message.data?.channelId === voiceChannelId, "member voice binding acknowledgment");
  memberBound.send(JSON.stringify({ type: "voice:bind", channelId: voiceChannelId }));
  await boundMemberEvent;
  const unboundMemberError = waitFor(memberUnbound, message =>
    message.type === "error" && message.code === "VOICE_ACCESS_DENIED",
  "unbound connection rejected from voice binding");
  memberUnbound.send(JSON.stringify({ type: "voice:bind", channelId: voiceChannelId + 100000 }));
  await unboundMemberError;
  const peerBoundEvent = waitFor(peerBound, message => message.type === "voice:bound" &&
    message.data?.channelId === voiceChannelId, "peer voice binding acknowledgment");
  peerBound.send(JSON.stringify({ type: "voice:bind", channelId: voiceChannelId }));
  await peerBoundEvent;
  const voiceTopicBarrier = waitFor(peerBound, message => message.type === "pong", "peer voice topic subscribed");
  peerBound.send(JSON.stringify({ type: "subscribe", channel: `channel:${voiceChannelId}` }));
  peerBound.send(JSON.stringify({ type: "ping" }));
  await voiceTopicBarrier;
  const peerUnboundEvents = [];
  peerUnbound.on("message", raw => {
    try { peerUnboundEvents.push(JSON.parse(raw.toString())); } catch {}
  });

  const signal = { type: "voice:offer", targetUserId: ids[peerName], sdp: { type: "offer", sdp: `synthetic-${suffix}` } };
  const unboundSignalBarrier = waitFor(memberUnbound, message => message.type === "pong",
    "unbound signal processing barrier");
  const boundSignal = waitFor(peerBound, message =>
    message.type === "voice:offer" && message.data?.sdp?.sdp === signal.sdp.sdp,
  "voice signal delivered to bound peer connection");
  memberUnbound.send(JSON.stringify(signal));
  memberUnbound.send(JSON.stringify({ type: "ping" }));
  await unboundSignalBarrier;
  assert.equal(peerUnboundEvents.some(message => message.type === "voice:offer" &&
    message.data?.sdp?.sdp === signal.sdp.sdp), false,
  "voice signaling from a connection not bound to the voice channel is not relayed");
  memberBound.send(JSON.stringify(signal));
  const deliveredSignal = await boundSignal;
  assert.equal(deliveredSignal.data.channelId, voiceChannelId);
  assert.equal(deliveredSignal.data.fromUserId, memberId);
  const peerSignalBarrier = waitFor(peerUnbound, message => message.type === "pong",
    "peer unbound-connection delivery barrier");
  peerUnbound.send(JSON.stringify({ type: "ping" }));
  await peerSignalBarrier;
  assert.equal(peerUnboundEvents.some(message => message.type === "voice:offer" &&
    message.data?.sdp?.sdp === signal.sdp.sdp), false,
  "voice signaling is delivered only to the target's connection bound to the shared voice channel");
  console.log("PASS voice signaling is scoped to bound connections in the shared voice channel");

  const lost = waitFor(peerBound, message => message.type === "voice:member_leave" &&
    message.data?.userId === memberId && message.data?.reason === "connection_lost",
  "peer informed of member connection loss");
  memberBound.close();
  await once(memberBound, "close");
  await lost;
  const afterLoss = expectStatus(await peer.request(`/api/channels/${voiceChannelId}/voice`),
    200, "voice membership after disconnect");
  assert.equal(afterLoss.some(item => item.userId === memberId), false);
  const memberReconnected = await connect(member);
  const rejected = waitFor(memberReconnected, message =>
    message.type === "error" && message.code === "VOICE_MEMBERSHIP_REQUIRED" &&
    message.channelId === voiceChannelId, "new connection cannot bind without rejoining");
  memberReconnected.send(JSON.stringify({ type: "voice:bind", channelId: voiceChannelId }));
  await rejected;
  expectStatus(await member.request(`/api/channels/${voiceChannelId}/voice/join`, {
    method: "POST",
  }), 200, "restore voice reservation after disconnect");
  const restoredJoin = waitFor(peerBound, message => message.type === "voice:member_join" &&
    message.data?.member?.userId === memberId, "peer sees restored voice member");
  const restoredBound = waitFor(memberReconnected, message =>
    message.type === "voice:bound" && message.data?.channelId === voiceChannelId,
  "replacement socket voice binding acknowledgment");
  memberReconnected.send(JSON.stringify({ type: "voice:bind", channelId: voiceChannelId }));
  await Promise.all([restoredBound, restoredJoin]);
  const afterRecovery = expectStatus(await peer.request(`/api/channels/${voiceChannelId}/voice`),
    200, "voice membership after reconnection");
  assert.ok(afterRecovery.some(item => item.userId === memberId));
  const restoredSignal = waitFor(peerBound, message =>
    message.type === "voice:offer" && message.data?.sdp?.sdp === `restored-${suffix}`,
  "voice signaling after reconnection");
  memberReconnected.send(JSON.stringify({
    ...signal, sdp: { type: "offer", sdp: `restored-${suffix}` },
  }));
  await restoredSignal;
  console.log("PASS disconnect removes voice membership with an explicit reason; rejoin and rebind restore visibility and signaling");

  // A fresh process has no in-memory membership. It must reject stale binds
  // and permit the same authenticated clients to rejoin and bind anew.
  apiProcess.kill("SIGTERM");
  await apiExit;
  apiProcess = spawn(process.execPath, [bundle], { cwd: apiCwd, env, stdio: ["ignore", "ignore", "ignore"] });
  apiExit = once(apiProcess, "exit");
  await waitForApiReady();
  const freshMember = await connect(member);
  const missingAfterRestart = waitFor(freshMember, message =>
    message.type === "error" && message.code === "VOICE_MEMBERSHIP_REQUIRED",
  "fresh process rejects stale voice binding");
  freshMember.send(JSON.stringify({ type: "voice:bind", channelId: voiceChannelId }));
  await missingAfterRestart;
  expectStatus(await member.request(`/api/channels/${voiceChannelId}/voice/join`, {
    method: "POST",
  }), 200, "rejoin voice after process restart");
  const reboundAfterRestart = waitFor(freshMember, message =>
    message.type === "voice:bound" && message.data?.channelId === voiceChannelId,
  "voice bound after process restart");
  freshMember.send(JSON.stringify({ type: "voice:bind", channelId: voiceChannelId }));
  await reboundAfterRestart;
  assert.ok(expectStatus(await member.request(`/api/channels/${voiceChannelId}/voice`),
    200, "membership visible after process restart").some(item => item.userId === memberId));
  console.log("PASS voice membership is explicitly restored after an isolated API process restart");
} finally {
  await cleanup();
}