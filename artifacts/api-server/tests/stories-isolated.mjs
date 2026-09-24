// Isolated stories flow against a disposable PostgreSQL database and API.
// All uploaded bytes, accounts, sessions, and database state are confined to /tmp.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(apiRoot, "../..");
const databaseRoot = path.join(repoRoot, "lib/db");
const apiRequire = createRequire(path.join(apiRoot, "package.json"));
const { build } = apiRequire("esbuild");
const esbuildPluginPino = apiRequire("esbuild-plugin-pino");

let tempRoot, pgBin, pgData, pgPort, apiPort, database, pgUser, env;
let apiProcess, apiExit, apiStderr = "", pgStarted = false;

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
    candidates.push(...readdirSync("/nix/store").filter(name => /^.+-postgresql-16(?:\..+)?$/.test(name))
      .map(name => path.join("/nix/store", name, "bin")));
  } catch {}
  return candidates.find(dir => ["initdb", "pg_ctl", "createdb", "psql", "postgres"]
    .every(binary => existsSync(path.join(dir, binary))));
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
  const isolated = { ...process.env };
  for (const key of Object.keys(isolated)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete isolated[key];
    }
  }
  delete isolated.REPLIT_DEV_DOMAIN;
  return {
    ...isolated,
    DATABASE_URL: databaseUrl,
    MESSAGE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    NODE_ENV: "development", LOG_LEVEL: "fatal",
    STORY_CLEANUP_ENABLED: "true",
    STORY_CLEANUP_INTERVAL_MS: "1000",
    STORY_CLEANUP_GRACE_MS: "0",
    PORT: String(apiPort), APP_URL: `http://127.0.0.1:${apiPort}`,
  };
}

function account() {
  const cookies = new Map();
  return {
    async request(url, { method = "GET", json, body, headers: extraHeaders = {} } = {}) {
      const headers = { ...extraHeaders };
      if (cookies.size) headers.Cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      if (cookies.has("csrf_token") && method !== "GET" && method !== "HEAD") {
        headers["x-csrf-token"] = cookies.get("csrf_token");
      }
      let requestBody = body;
      if (json !== undefined) {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(json);
      }
      const response = await fetch(`http://127.0.0.1:${apiPort}${url}`, { method, headers, body: requestBody });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const offset = pair.indexOf("=");
        if (offset > 0) cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
      }
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch { result = text; }
      return { status: response.status, result, headers: response.headers };
    },
  };
}

function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(response.result)}`);
  console.log(`PASS ${label} (${status})`);
  return response.result;
}

function buildTemporaryApi() {
  const buildDir = path.join(tempRoot, "api");
  const outDir = path.join(buildDir, "dist");
  return mkdir(outDir, { recursive: true })
    .then(() => symlink(path.join(apiRoot, "node_modules"), path.join(buildDir, "node_modules"), "dir"))
    .then(() => build({
      entryPoints: [path.join(apiRoot, "src/index.ts")],
      platform: "node", bundle: true, format: "esm", outdir: outDir,
      outExtension: { ".js": ".mjs" }, logLevel: "silent",
      external: [
        "*.node", "sharp", "better-sqlite3", "sqlite3", "canvas", "bcrypt", "argon2",
        "fsevents", "re2", "farmhash", "xxhash-addon", "bufferutil", "utf-8-validate",
        "ssh2", "cpu-features", "dtrace-provider", "isolated-vm", "lightningcss",
        "pg-native", "oracledb", "mongodb-client-encryption", "nodemailer", "handlebars",
        "knex", "typeorm", "protobufjs", "onnxruntime-node", "@tensorflow/*", "@prisma/client",
        "@mikro-orm/*", "@grpc/*", "@swc/*", "@aws-sdk/*", "playwright", "puppeteer",
        "puppeteer-core", "electron",
      ],
      plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
      banner: {
        js: `import { createRequire as __cr } from "node:module"; import __storyPath from "node:path"; import { fileURLToPath as __storyFileURLToPath } from "node:url"; globalThis.require=__cr(import.meta.url); globalThis.__filename=__storyFileURLToPath(import.meta.url); globalThis.__dirname=__storyPath.dirname(globalThis.__filename);`,
      },
    }))
    .then(() => path.join(outDir, "index.mjs"));
}

async function cleanup() {
  if (apiProcess?.exitCode === null && apiProcess?.signalCode === null) {
    apiProcess.kill("SIGTERM");
    await Promise.race([apiExit, new Promise(resolve => setTimeout(resolve, 2500))]);
    if (apiProcess.exitCode === null && apiProcess.signalCode === null) {
      apiProcess.kill("SIGKILL");
      await apiExit;
    }
  }
  if (pgStarted) {
    run(path.join(pgBin, "pg_ctl"), ["-D", pgData, "-m", "immediate", "-w", "stop"], { env });
    pgStarted = false;
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}

try {
  assert.equal(os.tmpdir(), "/tmp", "test requires isolated files under /tmp");
  pgBin = postgresBinDirectory();
  assert.ok(pgBin, "PostgreSQL 16 tools are required");
  assert.match(run(path.join(pgBin, "postgres"), ["--version"]), /PostgreSQL\) 16\b/);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "stories-isolated-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await freePort();
  apiPort = await freePort();
  pgUser = os.userInfo().username;
  database = `story_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}@127.0.0.1:${pgPort}/${database}`;
  env = isolatedEnvironment(databaseUrl);
  run(path.join(pgBin, "initdb"), [
    "-D", pgData, "--no-locale", "--encoding=UTF8", "--auth-local=trust", "--auth-host=trust",
  ], { env });
  run(path.join(pgBin, "pg_ctl"), [
    "-D", pgData, "-l", path.join(tempRoot, "postgres.log"),
    "-o", `-h 127.0.0.1 -p ${pgPort} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${tempRoot}`,
    "-w", "start",
  ], { env });
  pgStarted = true;
  run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, database], { env });
  const migration = spawnSync("pnpm", ["exec", "drizzle-kit", "migrate", "--config", "./drizzle.config.ts"], {
    cwd: databaseRoot, env, encoding: "utf8",
  });
  if (migration.error || migration.status !== 0) {
    throw new Error(`Temporary PostgreSQL migrations failed: ${migration.stderr ?? migration.error?.message}`);
  }
  console.log("PASS fresh disposable PostgreSQL database migrated");

  const bundle = await buildTemporaryApi();
  apiProcess = spawn(process.execPath, [bundle], {
    cwd: path.join(tempRoot, "api"), env, stdio: ["ignore", "ignore", "pipe"],
  });
  apiProcess.stderr.setEncoding("utf8");
  apiProcess.stderr.on("data", chunk => { apiStderr += chunk; });
  apiExit = once(apiProcess, "exit");
  const base = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) throw new Error(`Temporary API exited during startup: ${apiStderr}`);
    try {
      if ((await fetch(`${base}/api/auth/me`)).status === 401) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 401, "isolated API is ready and has no test session");
  console.log("PASS current API source serving only the isolated database and uploads");

  const creator = account();
  const viewer = account();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const creatorName = `story_owner_${suffix}`;
  const creatorPassword = `Temporary-${randomUUID()}!`;
  expectStatus(await creator.request("/api/auth/register", {
    method: "POST", json: { username: creatorName, password: creatorPassword, displayName: "Temporary Story Author" },
  }), 201, "register synthetic story author");
  expectStatus(await creator.request("/api/auth/login", {
    method: "POST", json: { username: creatorName, password: creatorPassword },
  }), 200, "login synthetic story author");
  const invite = expectStatus(await creator.request("/api/admin/invites", { method: "POST", json: {} }),
    201, "create synthetic viewer registration invite");
  const viewerName = `story_viewer_${suffix}`;
  const viewerPassword = `Temporary-${randomUUID()}!`;
  expectStatus(await viewer.request("/api/auth/register", {
    method: "POST", json: {
      username: viewerName, password: viewerPassword, displayName: "Temporary Story Viewer", inviteCode: invite.code,
    },
  }), 201, "register synthetic story viewer");
  expectStatus(await viewer.request("/api/auth/login", {
    method: "POST", json: { username: viewerName, password: viewerPassword },
  }), 200, "login synthetic story viewer");

  async function uploadStory(client, name) {
    const form = new FormData();
    form.append("file", new Blob([`synthetic story media ${name}`], { type: "image/png" }), name);
    return client.request("/api/stories", { method: "POST", body: form });
  }
  const firstStories = [];
  for (let index = 1; index <= 3; index++) {
    const story = expectStatus(await uploadStory(creator, `story-${index}.png`), 201,
      `publish active story ${index} using a separate upload`);
    firstStories.push(story);
  }
  const firstIds = firstStories.map(story => story.id);
  const firstMediaPath = new URL(firstStories[0].media_url, `http://127.0.0.1:${apiPort}`).pathname;
  assert.equal(new Set(firstIds).size, 3, "three consecutive story uploads create separate records");
  for (const story of firstStories) {
    const lifetime = new Date(story.expires_at).getTime() - new Date(story.created_at).getTime();
    assert.ok(Math.abs(lifetime - 24 * 60 * 60 * 1000) < 2000,
      "each story keeps its independent 24-hour lifetime");
  }
  const firstListing = expectStatus(await viewer.request("/api/stories"), 200, "viewer lists three active author stories");
  assert.deepEqual(firstListing.find(group => group.userId === firstStories[0].user_id)
    .stories.map(story => story.id), firstIds, "stories list in sequential creation order");
  assert.equal(firstListing.find(group => group.userId === firstStories[0].user_id).hasUnviewed, true);
  console.log("PASS three separate stories remain active, ordered, and independently expire after 24 hours");

  const activeMediaResponse = await viewer.request(firstMediaPath);
  const activeMedia = expectStatus(activeMediaResponse, 200,
    "authenticated viewer can fetch an active story file by its saved URL");
  assert.equal(activeMediaResponse.headers.get("cache-control"), "private, no-store",
    "active story media remains no-store");
  assert.match(activeMedia, /synthetic story media story-1\.png/,
    "active story media bytes are delivered");
  const unauthenticated = await fetch(`http://127.0.0.1:${apiPort}${firstMediaPath}`);
  assert.equal(unauthenticated.status, 401,
    "a copied story URL cannot be used without an authenticated session");
  const unrelatedFileRequest = await viewer.request("/api/uploads/story-999999-unknown.png");
  assert.equal(unrelatedFileRequest.status, 404,
    "a story-prefixed upload without a live database row is denied");
  console.log("PASS active story media URL checks authentication and a matching live story row");

  for (const storyId of firstIds.slice(0, 2)) {
    expectStatus(await viewer.request(`/api/stories/${storyId}/view`, { method: "POST" }), 204,
      `record view of story ${storyId} individually`);
    const viewers = expectStatus(await creator.request(`/api/stories/${storyId}/viewers`), 200,
      `author reads viewers for story ${storyId}`);
    assert.equal(viewers.length, 1);
    assert.equal(viewers[0].username, viewerName);
  }
  const afterTwoViews = expectStatus(await viewer.request("/api/stories"), 200,
    "refresh per-story viewed state after viewing two stories");
  const partiallyViewed = afterTwoViews.find(group => group.userId === firstStories[0].user_id);
  assert.deepEqual(partiallyViewed.stories.slice(0, 3).map(story => story.viewed), [true, true, false]);
  assert.equal(partiallyViewed.hasUnviewed, true, "author ring remains unviewed if any story is unviewed");
  assert.deepEqual(expectStatus(await creator.request(`/api/stories/${firstIds[2]}/viewers`), 200,
    "third story has a separate empty viewer list"), []);
  await viewer.request(`/api/stories/${firstIds[2]}/view`, { method: "POST" });
  const allViewed = expectStatus(await viewer.request("/api/stories"), 200, "all stories are now recorded as viewed");
  assert.equal(allViewed.find(group => group.userId === firstStories[0].user_id).hasUnviewed, false);
  console.log("PASS a view of one story never implicitly marks its siblings; unviewed summary tracks the group");

  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, "-d", database,
    "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c",
    `UPDATE stories SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${firstIds[0]}`,
  ], { env });
  const afterExpiration = expectStatus(await viewer.request("/api/stories"), 200,
    "expired story leaves the active feed independently");
  assert.deepEqual(afterExpiration.find(group => group.userId === firstStories[0].user_id)
    .stories.map(story => story.id), firstIds.slice(1));
  expectStatus(await viewer.request(firstMediaPath), 404,
    "the very same story URL stops delivering bytes after expiry");
  const temporaryUploadsDir = path.join(tempRoot, "api", "uploads");
  const expiredStoryFile = path.join(temporaryUploadsDir, path.basename(firstMediaPath));
  const cleanupDeadline = Date.now() + 8_000;
  let expiredStoryRows = 1;
  while (Date.now() < cleanupDeadline && expiredStoryRows !== 0) {
    const rows = run(path.join(pgBin, "psql"), [
      "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, "-d", database,
      "-X", "-q", "-t", "-A", "-c",
      `SELECT COUNT(*) FROM stories WHERE id = ${firstIds[0]}`,
    ], { env });
    expiredStoryRows = Number(rows.trim());
    if (expiredStoryRows !== 0) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(expiredStoryRows, 0, "periodic cleanup removes the expired story row after its expiry");
  assert.equal(existsSync(expiredStoryFile), false, "periodic cleanup removes the corresponding physical file");
  const expiredViews = run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", pgUser, "-d", database,
    "-X", "-q", "-t", "-A", "-c",
    `SELECT COUNT(*) FROM story_views WHERE story_id = ${firstIds[0]}`,
  ], { env });
  assert.equal(Number(expiredViews.trim()), 0, "deleting an expired story cascades to its view records");
  const activeSiblingMedia = expectStatus(await viewer.request(new URL(firstStories[1].media_url,
    `http://127.0.0.1:${apiPort}`).pathname), 200,
  "a still-live sibling story remains accessible after cleanup");
  assert.match(activeSiblingMedia, /synthetic story media story-2\.png/);
  console.log("PASS expiry denies the old URL immediately; cleanup removes only that story, its views, and its file");

  const acceptedRest = [];
  for (let index = 3; index < 10; index++) {
    acceptedRest.push(expectStatus(await uploadStory(creator, `story-${index + 1}.png`), 201,
      `active story count ${index} remains below the configured limit`));
  }
  const concurrent = await Promise.all([
    uploadStory(creator, "story-concurrent-a.png"),
    uploadStory(creator, "story-concurrent-b.png"),
  ]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [201, 429],
    "with one active slot left, simultaneous uploads must serialize so only one succeeds");
  const rejected = concurrent.find(result => result.status === 429);
  assert.match(rejected.result.error, /máximo de 10 historias activas/i);
  console.log("PASS concurrent over-limit upload rejected with a clear 429 message and per-user locking");
  const tenActive = expectStatus(await creator.request("/api/stories"), 200, "creator sees ten active stories at limit");
  assert.equal(tenActive.find(group => group.userId === firstStories[0].user_id).stories.length, 10);
  const uploadedFiles = await readdir(temporaryUploadsDir);
  assert.equal(uploadedFiles.length, 10, "ten active stories remain; expired and rejected upload bytes were removed");
  console.log("PASS the rejected upload left no orphaned file; all synthetic records/files are under /tmp");
} finally {
  await cleanup();
  console.log("PASS temporary API, PostgreSQL data, sessions, users, and upload bytes cleaned up");
}