// Security regression test for uploaded-media delivery. The PostgreSQL cluster,
// API working directory, sessions, and all upload bytes are disposable /tmp data.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
let selectedApiPort;
let databaseName;
let apiProcess;
let apiExit;
let browserProcess;
let browserExit;
let pgStarted = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} failed (${result.error?.message ?? `exit ${result.status}`})\n${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

function executeIsolatedSql(statement, env, tuplesOnly = false) {
  const args = [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", os.userInfo().username,
    "-d", databaseName, "-X", "-q",
  ];
  if (tuplesOnly) args.push("-t", "-A");
  args.push("-v", "ON_ERROR_STOP=1", "-c", statement);
  return run(path.join(pgBin, "psql"), args, { env }).trim();
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

function makeSyntheticWav() {
  const sampleRate = 8_000;
  const sampleCount = 800;
  const sampleBytes = sampleCount * 2;
  const wav = Buffer.alloc(44 + sampleBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + sampleBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(sampleBytes, 40);
  return wav;
}

async function runHeadlessMediaSmoke({ base, cookies, imageAssets, noStoreAttachmentPath, lowSensitivityPaths, videoPath }) {
  const chromium = spawnSync("which", ["chromium"], { encoding: "utf8" }).stdout?.trim();
  if (!chromium) {
    console.log("LIMITATION Chromium is unavailable; headless browser media-element smoke test not verified");
    return false;
  }

  const debugPort = await freePort();
  browserProcess = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${path.join(tempRoot, "chromium-profile")}`,
    "about:blank",
  ], { stdio: "ignore" });
  browserExit = once(browserProcess, "exit");

  const debugBase = `http://127.0.0.1:${debugPort}`;
  let version;
  const debugDeadline = Date.now() + 15_000;
  while (Date.now() < debugDeadline) {
    if (browserProcess.exitCode !== null) throw new Error("Headless Chromium exited before DevTools readiness");
    try {
      const response = await fetch(`${debugBase}/json/version`);
      if (response.ok) { version = await response.json(); break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(version, "headless Chromium DevTools endpoint becomes ready");

  const targetResponse = await fetch(`${debugBase}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  assert.equal(targetResponse.status, 200, "create an isolated Chromium page target");
  const target = await targetResponse.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let commandId = 0;
  const pending = new Map();
  const eventListeners = new Map();
  const mediaPaths = new Set([...imageAssets.map(asset => asset.path), videoPath]);
  const mediaRequestsById = new Map();
  const mediaResponses = new Map();
  const passMetrics = [];
  let activePass = null;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(`CDP ${message.error.message}`));
      else callback.resolve(message.result ?? {});
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params.request;
      const requestUrl = new URL(request.url);
      if (mediaPaths.has(requestUrl.pathname)) {
        const record = {
          path: requestUrl.pathname, pass: activePass, status: null, headers: {},
          servedFromCache: false, transferredBytes: 0, finished: false,
        };
        mediaRequestsById.set(message.params.requestId, record);
        if (activePass !== null) passMetrics[activePass].requests.push(record);
      }
    }
    if (message.method === "Network.requestServedFromCache") {
      const record = mediaRequestsById.get(message.params.requestId);
      if (record) record.servedFromCache = true;
    }
    if (message.method === "Network.responseReceived") {
      const response = message.params.response;
      const mediaUrl = new URL(response.url);
      if (mediaPaths.has(mediaUrl.pathname)) {
        const record = mediaRequestsById.get(message.params.requestId);
        if (record) {
          record.status = response.status;
          record.mimeType = response.mimeType;
          record.headers = response.headers ?? {};
        }
        mediaResponses.set(mediaUrl.pathname, { status: response.status, mimeType: response.mimeType });
      }
    }
    if (message.method === "Network.loadingFinished") {
      const record = mediaRequestsById.get(message.params.requestId);
      if (record) {
        record.transferredBytes = message.params.encodedDataLength ?? 0;
        record.finished = true;
      }
    }
    if (message.method === "Network.loadingFailed") {
      const record = mediaRequestsById.get(message.params.requestId);
      if (record) record.finished = true;
    }
    if (message.method === "Network.requestWillBeSent" && message.params.redirectResponse) {
      const record = mediaRequestsById.get(message.params.requestId);
      if (record) record.finished = true;
    }
    for (const callback of eventListeners.get(message.method) ?? []) callback(message.params);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++commandId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, 15_000);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const waitForEvent = (name, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    const listeners = eventListeners.get(name) ?? [];
    const callback = value => {
      clearTimeout(timer);
      eventListeners.set(name, listeners.filter(item => item !== callback));
      resolve(value);
    };
    const timer = setTimeout(() => {
      eventListeners.set(name, listeners.filter(item => item !== callback));
      reject(new Error(`CDP event timed out: ${name}`));
    }, timeoutMs);
    listeners.push(callback);
    eventListeners.set(name, listeners);
  });

  try {
    await command("Page.enable");
    await command("Runtime.enable");
    await command("Network.enable");
    for (const [name, value] of cookies) {
      const cookie = await command("Network.setCookie", {
        name, value, url: base, httpOnly: name === "connect.sid", sameSite: "Lax",
      });
      assert.notEqual(cookie.success, false, `set isolated browser session cookie ${name}`);
    }

    const imageSpecs = JSON.stringify(imageAssets);
    const videoSpec = JSON.stringify(videoPath);
    const expression = `(() => {
      const images = ${imageSpecs};
      const videoPath = ${videoSpec};
      document.open();
      document.write("<!doctype html><html><head><meta charset='utf-8'><title>Isolated synthetic media view</title></head><body></body></html>");
      document.close();
      const imageLoads = images.map(asset => new Promise(resolve => {
        const image = new Image();
        const timer = setTimeout(() => resolve({ label: asset.label, loaded: false, timeout: true }), 10000);
        image.onload = () => { clearTimeout(timer); resolve({ label: asset.label, loaded: true, width: image.naturalWidth }); };
        image.onerror = () => { clearTimeout(timer); resolve({ label: asset.label, loaded: false, error: true }); };
        image.src = asset.path;
        document.body.appendChild(image);
      }));
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      const videoLoad = new Promise(resolve => {
        const timer = setTimeout(() => resolve({ loaded: false, timeout: true, readyState: video.readyState }), 12000);
        video.onloadeddata = () => { clearTimeout(timer); resolve({ loaded: true, readyState: video.readyState }); };
        video.onerror = () => { clearTimeout(timer); resolve({ loaded: false, error: video.error?.code ?? null, readyState: video.readyState }); };
        video.src = videoPath;
        document.body.appendChild(video);
        video.load();
        video.play().catch(() => {});
      });
      return Promise.all([Promise.all(imageLoads), videoLoad]).then(([images, video]) => ({ images, video }));
    })()`;
    const renderResults = [];
    for (let index = 0; index < 2; index++) {
      const pass = { requests: [] };
      passMetrics.push(pass);
      activePass = index;
      const startedAt = Date.now();
      // Each pass is a new top-level document navigation on the API origin.
      // Cookies and media URL paths are deliberately unchanged between passes.
      const apiPageLoaded = waitForEvent("Page.loadEventFired");
      await command("Page.navigate", { url: `${base}/api/auth/me` });
      await apiPageLoaded;
      const evaluation = await command("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true, timeout: 20_000,
      });
      const smoke = evaluation.result?.value;
      assert.ok(smoke, `headless browser returned media-element results: ${JSON.stringify(evaluation.result?.exceptionDetails)}`);
      for (const image of smoke.images) {
        assert.equal(image.loaded, true, `headless Chromium loaded protected ${image.label} on render ${index + 1}: ${JSON.stringify(image)}`);
        assert.ok(image.width > 0, `${image.label} has nonzero natural width on render ${index + 1}`);
      }
      assert.equal(smoke.video.loaded, true, `headless Chromium decoded protected video on render ${index + 1}: ${JSON.stringify(smoke.video)}`);
      const idleUntil = Date.now() + 5_000;
      let idleSince = null;
      while (Date.now() < idleUntil) {
        const activeRequests = pass.requests.filter(request => !request.finished);
        if (activeRequests.length === 0) {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= 150) break;
        } else {
          idleSince = null;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      activePass = null;
      for (const asset of imageAssets) {
        assert.equal(mediaResponses.get(asset.path)?.status, 200,
          `browser requested ${asset.label} with an authorized 200 resource response`);
      }
      assert.ok([200, 206].includes(mediaResponses.get(videoPath)?.status),
        `browser video resource response is authorized: ${JSON.stringify(mediaResponses.get(videoPath))}`);
      renderResults.push({
        elapsedMs: Date.now() - startedAt,
        requests: pass.requests,
      });
    }

    const describePass = (pass, index) => {
      const paths = [...new Set(pass.requests.map(request => request.path))];
      const resources = paths.map(resourcePath => {
        const requests = pass.requests.filter(request => request.path === resourcePath);
        return {
          path: resourcePath,
          requestCount: requests.length,
          transferredBytes: requests.reduce((sum, request) => sum + request.transferredBytes, 0),
          cacheHits: requests.filter(request => request.servedFromCache).length,
          statuses: requests.map(request => request.status),
          cacheControl: requests.find(request => request.headers["Cache-Control"] ?? request.headers["cache-control"])?.headers["Cache-Control"] ??
            requests.find(request => request.headers["cache-control"])?.headers["cache-control"] ?? null,
        };
      });
      return { render: index + 1, elapsedMs: pass.elapsedMs, resources };
    };
    const metricPasses = renderResults.map((result, index) => describePass(result, index));
    console.log(`Chromium media render metrics (CDP Network.responseReceived + requestServedFromCache + loadingFinished encodedDataLength; same cookie and paths; two document navigations): ${JSON.stringify(metricPasses)}`);

    const attachmentPasses = renderResults.map(pass => pass.requests.filter(request => request.path === noStoreAttachmentPath));
    assert.ok(attachmentPasses.every(requests => requests.length > 0),
      "no-store attachment is requested on both separate document renders");
    assert.ok(attachmentPasses.every(requests => requests.some(request => request.transferredBytes > 0)),
      "no-store attachment transfers bytes again on each render");
    assert.ok(attachmentPasses.flat().every(request => /no-store/i.test(
      request.headers["Cache-Control"] ?? request.headers["cache-control"] ?? "",
    )), "attachment retains its explicit no-store response policy");

    for (const resourcePath of lowSensitivityPaths) {
      const firstRequests = renderResults[0].requests.filter(request => request.path === resourcePath);
      const secondRequests = renderResults[1].requests.filter(request => request.path === resourcePath);
      assert.ok(firstRequests.length > 0, `first render requested cache-eligible resource ${resourcePath}`);
      assert.ok(firstRequests.every(request =>
        (request.headers["Cache-Control"] ?? request.headers["cache-control"]) === "private, max-age=180, must-revalidate"),
      `profile/server image ${resourcePath} has the exact 180-second private cache policy`);
      assert.ok(secondRequests.length > 0, `second render requested cache-eligible resource ${resourcePath}`);
      assert.ok(secondRequests.some(request => request.servedFromCache),
        `second render served ${resourcePath} from the browser cache`);
      assert.equal(secondRequests.reduce((sum, request) => sum + request.transferredBytes, 0), 0,
        `second render transferred no body bytes for cached resource ${resourcePath}`);
    }
    assert.ok(attachmentPasses[1].every(request => !request.servedFromCache && request.transferredBytes > 0),
      "no-store attachment is fetched from the network rather than browser cache on render two");
    const clipRequests = renderResults.flatMap(pass => pass.requests.filter(request => request.path === videoPath));
    assert.ok(clipRequests.length > 0 && clipRequests.every(request =>
      (request.headers["Cache-Control"] ?? request.headers["cache-control"]) === "private, max-age=60, must-revalidate"),
    "clip playback has the exact 60-second private cache policy");
    console.log("PASS second navigation served all four profile/server images from cache; no-store attachment transferred again");
    console.log(`PASS headless Chromium completed two separate media-view navigations and loaded ${imageAssets.length} protected images plus video`);
    return true;
  } finally {
    socket.close();
  }
}

function isolatedEnvironment(databaseUrl) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|SERVICE|SERVICEFILE|OPTIONS|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY)$/.test(key)) {
      delete env[key];
    }
  }
  delete env.REPLIT_DEV_DOMAIN;
  for (const key of Object.keys(env)) if (/^GIPHY/i.test(key)) delete env[key];
  delete env.Giphy;
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    MESSAGE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    NODE_ENV: "development",
    LOG_LEVEL: "fatal",
    PORT: String(selectedApiPort),
    APP_URL: `http://127.0.0.1:${selectedApiPort}`,
  };
}

function account(base) {
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
      const response = await fetch(base + url, { method, headers, body: requestBody });
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const offset = pair.indexOf("=");
        if (offset > 0) cookies.set(pair.slice(0, offset), pair.slice(offset + 1));
      }
      const raw = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") ?? "";
      let result;
      if (contentType.includes("application/json")) {
        try { result = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { result = null; }
      } else {
        result = Buffer.from(raw);
      }
      return { status: response.status, result, headers: response.headers };
    },
  };
}

function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${Buffer.isBuffer(response.result) ? response.result.toString("utf8") : JSON.stringify(response.result)}`);
  console.log(`PASS ${label} (${status})`);
  return response.result;
}

function assertMediaPolicy(response, cacheControl, label) {
  assert.equal(response.headers.get("cache-control"), cacheControl, `${label} Cache-Control`);
  assert.ok(response.headers.get("etag"), `${label} includes ETag`);
  assert.ok(response.headers.get("last-modified"), `${label} includes Last-Modified`);
}

async function assertConditionalMedia304(client, mediaPath, etag, label) {
  assert.ok(etag, `${label} has an ETag to validate`);
  // Undici adds Cache-Control: no-cache for manually conditional requests;
  // Express deliberately treats that as stale, so send max-age=0 instead.
  const response = await client.request(mediaPath, {
    headers: { "If-None-Match": etag, "Cache-Control": "max-age=0", Pragma: "" },
  });
  assert.equal(response.status, 304,
    `${label} authorized conditional request returns 304 (sent ETag ${etag}; received ${response.status}, ETag ${response.headers.get("etag")})`);
  assert.equal(response.result.length, 0, `${label} 304 has no response body`);
  return response;
}

function expectDenied(response, label) {
  assert.ok([401, 403, 404].includes(response.status),
    `${label}: expected a denial, got ${response.status}`);
  console.log(`PASS ${label} (${response.status})`);
}

function buildApiIntoTemp() {
  const buildDir = path.join(tempRoot, "api");
  const outDir = path.join(buildDir, "dist");
  return mkdir(outDir, { recursive: true }).then(() =>
    symlink(path.join(apiRoot, "node_modules"), path.join(buildDir, "node_modules"), "dir")
  ).then(() => build({
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
  })).then(() => path.join(outDir, "index.mjs"));
}

async function cleanup() {
  if (browserProcess?.exitCode === null && browserProcess?.signalCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([browserExit, new Promise(resolve => setTimeout(resolve, 3000))]);
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) {
      browserProcess.kill("SIGKILL");
      await browserExit;
    }
  }
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
  assert.equal(os.tmpdir(), "/tmp", "this test requires all data under /tmp");
  pgBin = postgresBinDirectory();
  assert.ok(pgBin, "PostgreSQL 16 tools are required");
  assert.match(run(path.join(pgBin, "postgres"), ["--version"]), /PostgreSQL\) 16\b/);

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "media-auth-isolated-"));
  pgData = path.join(tempRoot, "postgres-data");
  pgPort = await freePort();
  selectedApiPort = await freePort();
  const pgUser = os.userInfo().username;
  databaseName = `media_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
    throw new Error(
      `Temporary database migrations failed (${migration.error?.message ?? `exit ${migration.status}`})\n` +
      `${migration.stdout ?? ""}\n${migration.stderr ?? ""}`,
    );
  }
  console.log("PASS fresh disposable PostgreSQL 16 database migrated");

  const bundle = await buildApiIntoTemp();
  const apiCwd = path.join(tempRoot, "api");
  await mkdir(path.join(apiCwd, "uploads"), { recursive: true });
  const base = `http://127.0.0.1:${selectedApiPort}`;
  apiProcess = spawn(process.execPath, [bundle], { cwd: apiCwd, env, stdio: ["ignore", "ignore", "ignore"] });
  apiExit = once(apiProcess, "exit");
  const readyUntil = Date.now() + 20_000;
  while (Date.now() < readyUntil) {
    if (apiProcess.exitCode !== null) throw new Error("Isolated API exited before readiness");
    try {
      if ((await fetch(`${base}/api/auth/me`)).status === 401) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
  console.log("PASS current API source serves only isolated uploads and DB");

  const owner = account(base);
  const member = account(base);
  const outsider = account(base);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ownerPass = `Temporary-${randomUUID()}!`;
  const firstReg = expectStatus(await owner.request("/api/auth/register", {
    method: "POST", json: { username: `media_owner_${suffix}`, password: ownerPass, displayName: "Temp media owner" },
  }), 201, "register isolated media-server owner");
  const ownerLogin = expectStatus(await owner.request("/api/auth/login", {
    method: "POST", json: { username: `media_owner_${suffix}`, password: ownerPass },
  }), 200, "log in isolated media-server owner");
  const memberInvite = expectStatus(await owner.request("/api/admin/invites", { method: "POST", json: {} }), 201, "create disposable member invite");
  const outsiderInvite = expectStatus(await owner.request("/api/admin/invites", { method: "POST", json: {} }), 201, "create disposable outsider invite");

  const memberPass = `Temporary-${randomUUID()}!`;
  expectStatus(await member.request("/api/auth/register", {
    method: "POST", json: {
      username: `media_member_${suffix}`, password: memberPass, displayName: "Temp media member",
      inviteCode: memberInvite.code,
    },
  }), 201, "register synthetic channel member");
  const memberLogin = expectStatus(await member.request("/api/auth/login", {
    method: "POST", json: { username: `media_member_${suffix}`, password: memberPass },
  }), 200, "log in synthetic channel member");
  const outsiderPass = `Temporary-${randomUUID()}!`;
  expectStatus(await outsider.request("/api/auth/register", {
    method: "POST", json: {
      username: `media_outsider_${suffix}`, password: outsiderPass, displayName: "Temp media outsider",
      inviteCode: outsiderInvite.code,
    },
  }), 201, "register synthetic outsider");
  expectStatus(await outsider.request("/api/auth/login", {
    method: "POST", json: { username: `media_outsider_${suffix}`, password: outsiderPass },
  }), 200, "log in synthetic outsider");
  assert.ok(firstReg.id && ownerLogin.id && memberLogin.id);

  const server = expectStatus(await owner.request("/api/servers", {
    method: "POST", json: { name: "Disposable media-access server" },
  }), 201, "create disposable server");
  const serverId = server.id;
  const invite = expectStatus(await owner.request(`/api/servers/${serverId}/invites`, {
    method: "POST", json: {},
  }), 201, "create disposable server invitation");
  expectStatus(await member.request("/api/servers/join-by-invite", {
    method: "POST", json: { code: invite.code },
  }), 200, "member joins disposable server");

  const role = expectStatus(await owner.request(`/api/servers/${serverId}/roles`, {
    method: "POST", json: { name: "temporary-media-readers", permissions: 0 },
  }), 201, "create temporary restricted-channel role");
  expectStatus(await owner.request(`/api/servers/${serverId}/members/${memberLogin.id}/roles/${role.id}`, {
    method: "POST",
  }), 200, "grant restricted-channel role to synthetic member");
  const restricted = expectStatus(await owner.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "private-images", channelType: "text", restrictedRoles: [role.id] },
  }), 201, "create restricted text channel");
  const privateMedia = expectStatus(await owner.request(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "private-library", channelType: "media", restrictedRoles: [role.id] },
  }), 201, "create restricted media library channel");

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const pdf = Buffer.from("%PDF-1.4\nsynthetic private document\n%%EOF\n", "ascii");
  async function uploadMessageAttachment(client, channelId, filename, bytes, mimeType) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    const uploaded = expectStatus(await client.request(`/api/channels/${channelId}/attachments`, {
      method: "POST", body: form,
    }), 201, `upload ${filename} as a message attachment`);
    const message = expectStatus(await client.request(`/api/channels/${channelId}/messages`, {
      method: "POST", json: { content: `synthetic ${filename}`, attachmentIds: [uploaded.id] },
    }), 201, `attach ${filename} to a channel message`);
    assert.ok(message.attachments?.some(item => item.id === uploaded.id));
    return { attachment: uploaded, message, path: new URL(uploaded.url, base).pathname };
  }

  const image = await uploadMessageAttachment(member, restricted.id, "authorized.png", png, "image/png");
  const doc = await uploadMessageAttachment(member, restricted.id, "forced-download.pdf", pdf, "application/pdf");
  // Legacy rows may still have a valid message link while their old attachment
  // metadata has a NULL channel and a false claimed flag. Resolve channel access
  // through the owning message rather than rejecting these rows as previews.
  executeIsolatedSql(
    `UPDATE message_attachments SET channel_id = NULL, claimed = FALSE WHERE id = ${Number(image.attachment.id)}`,
    env,
  );
  expectStatus(await member.request(image.path), 200,
    "current channel member can read a legacy attachment linked to a live message");
  expectDenied(await outsider.request(image.path),
    "outsider cannot read a legacy message-linked attachment with NULL channel and false claimed flag");
  const previewForm = new FormData();
  previewForm.append("file", new Blob([png], { type: "image/png" }), "composer-preview.png");
  const preview = expectStatus(await member.request(`/api/channels/${restricted.id}/attachments`, {
    method: "POST", body: previewForm,
  }), 201, "upload an unclaimed composer preview");
  const previewPath = new URL(preview.url, base).pathname;
  expectStatus(await member.request(previewPath), 200, "uploader can display its own current composer preview");
  expectDenied(await outsider.request(previewPath), "outsider cannot display a copied unclaimed preview URL");
  const noSessionImage = await fetch(base + image.path);
  expectDenied({ status: noSessionImage.status }, "anonymous request to an exact valid channel attachment URL is denied");

  const authorizedImage = await member.request(image.path);
  expectStatus(authorizedImage, 200, "current restricted-role member downloads its channel attachment");
  assert.ok(authorizedImage.result.equals(png));
  assertMediaPolicy(authorizedImage, "private, no-store, max-age=0", "message attachment");
  assert.equal(authorizedImage.headers.get("x-content-type-options"), "nosniff");
  assert.equal(authorizedImage.headers.get("content-security-policy"), "default-src 'none'");
  assert.match(authorizedImage.headers.get("content-type") ?? "", /^image\/png\b/);
  const imageWithOrigin = await member.request(image.path, {
    headers: { Origin: base },
  });
  expectStatus(imageWithOrigin, 200, "allowed-origin protected image remains accessible");
  assert.equal(imageWithOrigin.headers.get("access-control-allow-origin"), base);
  assert.match(imageWithOrigin.headers.get("vary") ?? "", /(?:^|,\s*)Origin(?:,|$)/i);
  assert.match(imageWithOrigin.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
  await assertConditionalMedia304(member, image.path, authorizedImage.headers.get("etag"), "authorized attachment");
  const authorizedPdf = await member.request(doc.path);
  expectStatus(authorizedPdf, 200, "current restricted-role member downloads its document");
  assert.equal(authorizedPdf.headers.get("content-disposition"), "attachment");
  assert.equal(authorizedPdf.headers.get("x-content-type-options"), "nosniff");
  assert.equal(authorizedPdf.headers.get("content-security-policy"), "default-src 'none'");
  console.log("PASS hardened static media headers preserved; unsafe document extensions remain forced downloads");

  expectDenied(await outsider.request(image.path), "authenticated outsider denied an exact restricted-channel attachment URL");
  expectDenied(await outsider.request(doc.path), "authenticated outsider denied an exact document URL");
  console.log("PASS possession of an exact channel attachment URL does not grant access");

  const restrictedMemberHistory = expectStatus(await member.request(`/api/channels/${restricted.id}/messages`),
    200, "authorized member reads its private channel message");
  assert.ok(restrictedMemberHistory.some(item => item.id === image.message.id));
  expectStatus(await outsider.request(`/api/channels/${restricted.id}/messages`), 403,
    "outsider cannot read restricted channel history");

  // Revoke a custom role through the real role route and verify media authorization
  // reflects the changed channel policy without changing the copied file URL.
  expectStatus(await owner.request(`/api/servers/${serverId}/members/${memberLogin.id}/roles/${role.id}`, {
    method: "DELETE",
  }), 204, "revoke temporary restricted-channel role");
  expectDenied(await member.request(image.path),
    "a member losing its restricted role immediately loses access to the same image URL");
  expectDenied(await member.request(`/api/channels/${privateMedia.id}/files`),
    "a member losing its restricted role cannot list private-library files");
  console.log("PASS restricted-channel and file-library permissions are re-evaluated after role revocation");
  // Restore access for the remaining positive library checks.
  expectStatus(await owner.request(`/api/servers/${serverId}/members/${memberLogin.id}/roles/${role.id}`, {
    method: "POST",
  }), 200, "restore disposable channel role for allowed file-library test");

  const bytes = Buffer.from("private library bytes, isolated", "utf8");
  const uploadInit = expectStatus(await member.request(`/api/channels/${privateMedia.id}/files/uploads`, {
    method: "POST", json: { filename: "library.txt", sizeBytes: bytes.length },
  }), 201, "begin private channel-library upload");
  const chunkForm = new FormData();
  chunkForm.append("chunk", new Blob([bytes], { type: "application/octet-stream" }), "chunk.bin");
  expectStatus(await member.request(`/api/channels/${privateMedia.id}/files/uploads/${uploadInit.uploadId}/chunks?offset=0`, {
    method: "POST", body: chunkForm,
  }), 200, "upload isolated private-library bytes");
  const file = expectStatus(await member.request(`/api/channels/${privateMedia.id}/files/uploads/${uploadInit.uploadId}/finish`, {
    method: "POST",
  }), 201, "finish private channel-library upload");
  const filePath = `/api/channels/${privateMedia.id}/files/${file.id}/download`;
  const libraryDownload = await member.request(filePath);
  expectStatus(libraryDownload, 200, "authorized member downloads private channel-library file");
  assert.ok(libraryDownload.result.equals(bytes));
  assertMediaPolicy(libraryDownload, "private, no-store, max-age=0", "channel-library download");
  assert.equal(libraryDownload.headers.get("x-content-type-options"), "nosniff");
  assert.equal(libraryDownload.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.match(libraryDownload.headers.get("content-disposition") ?? "", /attachment/);
  await assertConditionalMedia304(member, filePath, libraryDownload.headers.get("etag"), "authorized library download");
  expectDenied(await outsider.request(filePath), "outsider denied exact private-library download URL");
  expectDenied({ status: (await fetch(base + filePath)).status }, "anonymous request to private-library download denied");
  console.log("PASS channel-library direct download is authorized for current members only and retains hardened download headers");

  // Clips use existing server membership rather than channel membership.
  const clipForm = new FormData();
  clipForm.append("title", "Synthetic private clip");
  clipForm.append("file", new Blob([Buffer.from("synthetic clip bytes")], { type: "video/mp4" }), "clip.mp4");
  const clip = expectStatus(await owner.request(`/api/servers/${serverId}/clips`, {
    method: "POST", body: clipForm,
  }), 201, "upload disposable server clip");
  const clipPath = new URL(clip.video_url, base).pathname;
  const authorizedClip = await member.request(clipPath);
  expectStatus(authorizedClip, 200, "current server member can play authorized clip");
  assertMediaPolicy(authorizedClip, "private, max-age=60, must-revalidate", "server clip");
  await assertConditionalMedia304(member, clipPath, authorizedClip.headers.get("etag"), "authorized clip");
  expectDenied({ status: (await fetch(base + clipPath)).status }, "anonymous request to clip URL denied");
  expectDenied(await outsider.request(clipPath), "authenticated outsider denied exact clip URL");
  console.log("PASS clip files require an authenticated current server member");

  // Seed a synthetic soundboard row and WAV directly in the disposable DB and
  // uploads directory, avoiding upload-time ffprobe and external providers.
  const soundboardBytes = makeSyntheticWav();
  const soundboardFilename = `soundboard-${randomUUID()}.wav`;
  await writeFile(path.join(apiCwd, "uploads", soundboardFilename), soundboardBytes);
  const soundboardId = Number(executeIsolatedSql(
    `INSERT INTO soundboard_clips
       (server_id, name, duration_ms, size_bytes, mime_type, url, uploaded_by)
     VALUES (
       ${Number(serverId)}, 'Synthetic isolated sound', 100, ${soundboardBytes.length},
       'audio/wav', '/api/uploads/${soundboardFilename}', ${Number(ownerLogin.id)}
     )
     RETURNING id`,
    env,
    true,
  ));
  assert.ok(Number.isSafeInteger(soundboardId) && soundboardId > 0);
  const soundboardAudioPath = `/api/soundboard/clips/${soundboardId}/audio`;
  const authorizedSoundboard = await member.request(soundboardAudioPath);
  expectStatus(authorizedSoundboard, 200, "current server member downloads protected soundboard audio");
  assert.ok(authorizedSoundboard.result.equals(soundboardBytes));
  assertMediaPolicy(authorizedSoundboard, "private, max-age=60, must-revalidate", "soundboard audio");
  assert.equal(authorizedSoundboard.headers.get("x-content-type-options"), "nosniff");
  assert.equal(authorizedSoundboard.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(authorizedSoundboard.headers.get("content-disposition"), "attachment");
  assert.equal(authorizedSoundboard.headers.get("content-type"), "audio/wav");
  const soundWithOrigin = await member.request(soundboardAudioPath, {
    headers: { Origin: base },
  });
  expectStatus(soundWithOrigin, 200, "allowed-origin soundboard audio remains accessible");
  assert.equal(soundWithOrigin.headers.get("access-control-allow-origin"), base);
  assert.match(soundWithOrigin.headers.get("vary") ?? "", /(?:^|,\s*)Origin(?:,|$)/i);
  assert.match(soundWithOrigin.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
  await assertConditionalMedia304(member, soundboardAudioPath, authorizedSoundboard.headers.get("etag"), "authorized soundboard audio");
  expectDenied(await outsider.request(soundboardAudioPath), "outsider denied protected soundboard audio route");
  expectDenied({ status: (await fetch(base + soundboardAudioPath)).status },
    "anonymous request to protected soundboard audio route denied");
  expectDenied(await member.request(`/api/uploads/${soundboardFilename}`),
    "soundboard audio bytes remain unavailable through the direct upload path");
  console.log("PASS synthetic soundboard row serves hardened audio only through its authenticated member route");

  const ffmpegPath = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout?.trim();
  const videoDiskPath = path.join(apiCwd, "uploads", path.basename(clipPath));
  let browserPng;
  if (ffmpegPath) {
    run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.8",
      "-frames:v", "16", "-an", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", videoDiskPath,
    ]);
    const browserPngPath = path.join(tempRoot, "browser-smoke.png");
    run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16",
      "-frames:v", "1", "-threads", "1", "-y", browserPngPath,
    ]);
    browserPng = await readFile(browserPngPath);
    console.log("PASS generated a tiny synthetic H.264 clip with local ffmpeg under /tmp");
  } else {
    console.log("LIMITATION ffmpeg is unavailable; valid synthetic browser image/video fixtures and media-element smoke test not verified");
  }

  async function uploadProfileImage(route, label, imageBytes = png) {
    const form = new FormData();
    form.append("file", new Blob([imageBytes], { type: "image/png" }), `${label}.png`);
    const uploaded = expectStatus(await member.request(route, { method: "POST", body: form }),
      200, `upload synthetic user ${label}`);
    assert.equal(typeof uploaded.url, "string");
    return new URL(uploaded.url, base).pathname;
  }
  let avatarPath = await uploadProfileImage("/api/users/me/avatar", "avatar");
  let userBannerPath = await uploadProfileImage("/api/users/me/banner", "banner");
  for (const [assetPath, label] of [[avatarPath, "current user's avatar"], [userBannerPath, "current user's banner"]]) {
    const profileResponse = await member.request(assetPath);
    expectStatus(profileResponse, 200, `${label} remains visible to its owner`);
    assertMediaPolicy(profileResponse, "private, max-age=180, must-revalidate", label);
    await assertConditionalMedia304(member, assetPath, profileResponse.headers.get("etag"), label);
    expectStatus(await owner.request(assetPath), 200, `${label} remains visible to an authenticated profile viewer`);
    expectStatus(await outsider.request(assetPath), 200, `${label} remains discoverable to a different authenticated user`);
    expectDenied({ status: (await fetch(base + assetPath)).status }, `anonymous viewer denied ${label}`);
  }
  console.log("PASS globally discoverable user profile images keep authenticated rendering without bearer access");
  // A path can occur in more than one asset table. The stricter private-channel
  // policy must win over the otherwise globally discoverable profile-asset row.
  const quoteSql = value => `'${String(value).replaceAll("'", "''")}'`;
  expectStatus(await member.request(image.path), 200,
    "authorized channel member can read the attachment before the cross-asset collision");
  executeIsolatedSql(
    `UPDATE users SET avatar_url = ${quoteSql(image.path)} WHERE id = ${Number(memberLogin.id)}`,
    env,
  );
  expectDenied(await member.request(image.path),
    "ambiguous attachment/avatar URL fails closed for its authorized channel member");
  expectDenied(await outsider.request(image.path),
    "ambiguous attachment/avatar URL fails closed for an outsider");
  executeIsolatedSql(
    `UPDATE users SET avatar_url = ${quoteSql(avatarPath)} WHERE id = ${Number(memberLogin.id)}`,
    env,
  );
  expectStatus(await member.request(image.path), 200,
    "authorized channel member can read attachment after duplicate asset reference is removed");
  console.log("PASS colliding profile and private attachment records retain the stricter channel policy");

  async function uploadServerImage(route, label, imageBytes = png) {
    const form = new FormData();
    form.append("file", new Blob([imageBytes], { type: "image/png" }), `${label}.png`);
    const uploaded = expectStatus(await owner.request(route, { method: "POST", body: form }),
      200, `upload synthetic server ${label}`);
    assert.equal(typeof uploaded.url, "string");
    return new URL(uploaded.url, base).pathname;
  }
  let serverIconPath = await uploadServerImage(`/api/servers/${serverId}/icon`, "icon");
  let serverBannerPath = await uploadServerImage(`/api/servers/${serverId}/banner`, "banner");
  for (const [assetPath, label] of [[serverIconPath, "server icon"], [serverBannerPath, "server banner"]]) {
    const serverResponse = await owner.request(assetPath);
    expectStatus(serverResponse, 200, `server owner can see its ${label}`);
    assertMediaPolicy(serverResponse, "private, max-age=180, must-revalidate", label);
    await assertConditionalMedia304(owner, assetPath, serverResponse.headers.get("etag"), label);
    expectStatus(await member.request(assetPath), 200, `current server member can see its ${label}`);
    expectDenied({ status: (await fetch(base + assetPath)).status }, `anonymous viewer denied ${label}`);
    expectDenied(await outsider.request(assetPath), `outsider denied exact ${label} URL`);
  }
  console.log("PASS server icons and banners are available only to authenticated current server members");

  // HEAD and byte-range media requests must pass through the same authorization
  // check as GET. Authorized browser media playback may use either method.
  const ranged = await member.request(image.path, {
    headers: { Range: "bytes=0-7" },
  });
  assert.equal(ranged.status, 206, `authorized Range request should return partial content, got ${ranged.status}`);
  assert.equal(ranged.result.length, 8);
  assert.equal(ranged.headers.get("content-range"), "bytes 0-7/9");
  const profileAssets = [[avatarPath, "user avatar"], [userBannerPath, "user banner"]];
  const serverAssets = [[serverIconPath, "server icon"], [serverBannerPath, "server banner"]];
  for (const [assetPath, label] of [...profileAssets, ...serverAssets]) {
    const head = await member.request(assetPath, { method: "HEAD" });
    expectStatus(head, 200, `authorized HEAD request for ${label}`);
    assert.equal(head.result.length, 0);
    assert.equal(head.headers.get("content-length"), String(png.length));
    const partial = await member.request(assetPath, { headers: { Range: "bytes=0-7" } });
    assert.equal(partial.status, 206, `authorized Range request for ${label}`);
    assert.equal(partial.result.length, 8);
    assert.equal(partial.headers.get("content-range"), "bytes 0-7/9");
  }
  expectDenied(await outsider.request(image.path, { method: "HEAD" }),
    "outsider cannot bypass attachment authorization using HEAD");
  expectDenied(await outsider.request(image.path, { headers: { Range: "bytes=0-7" } }),
    "outsider cannot bypass attachment authorization using Range");
  for (const [assetPath, label] of serverAssets) {
    expectDenied(await outsider.request(assetPath, { method: "HEAD" }),
      `outsider cannot bypass ${label} membership using HEAD`);
    expectDenied(await outsider.request(assetPath, { headers: { Range: "bytes=0-7" } }),
      `outsider cannot bypass ${label} membership using Range`);
  }
  for (const [assetPath, label] of [...profileAssets, ...serverAssets]) {
    expectDenied({ status: (await fetch(base + assetPath, { method: "HEAD" })).status },
      `anonymous HEAD request for ${label} is denied`);
    expectDenied({ status: (await fetch(base + assetPath, { headers: { Range: "bytes=0-7" } })).status },
      `anonymous Range request for ${label} is denied`);
  }
  console.log("PASS HEAD and Range honor per-request access checks while authorized media playback remains functional");

  // No DB record (including retired Soundboard files served by their separate
  // route) may fall through to a bearer-style static file response.
  const unknownName = "orphaned-unknown-media.png";
  const soundboardName = "soundboard-9876543210-isolated.wav";
  await Promise.all([
    writeFile(path.join(apiCwd, "uploads", unknownName), png),
    writeFile(path.join(apiCwd, "uploads", soundboardName), Buffer.from("synthetic soundboard bytes")),
  ]);
  expectDenied(await member.request(`/api/uploads/${unknownName}`),
    "unknown direct upload has no static fallback");
  expectDenied(await member.request(`/api/uploads/${soundboardName}`),
    "legacy soundboard direct upload is rejected instead of bypassing its protected audio route");
  console.log("PASS unknown and soundboard-prefixed direct uploads do not become static bearer URLs");

  // Older DB rows may retain absolute Replit/production URLs. The authorization
  // lookup must match their path to the same stored file without trusting the
  // historical hostname as a credential.
  const legacyHost = "https://legacy-media.example.invalid";
  const sqlQuote = value => `'${String(value).replaceAll("'", "''")}'`;
  const clipFilename = path.basename(clipPath);
  const iconFilename = path.basename(serverIconPath);
  const bannerFilename = path.basename(serverBannerPath);
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", os.userInfo().username,
    "-d", databaseName,
    "-X", "-q", "-v", "ON_ERROR_STOP=1",
    "-c", `UPDATE clips SET video_url = ${sqlQuote(`${legacyHost}/api/uploads/${clipFilename}`)} WHERE id = ${Number(clip.id)};
          UPDATE servers SET icon_url = ${sqlQuote(`${legacyHost}/api/uploads/${iconFilename}`)},
                             banner_url = ${sqlQuote(`${legacyHost}/api/uploads/${bannerFilename}`)}
          WHERE id = ${Number(serverId)}`,
  ], { env });
  expectStatus(await member.request(clipPath), 200, "legacy absolute clip URL is matched to its guarded relative upload path");
  expectStatus(await member.request(serverIconPath), 200, "legacy absolute server icon URL retains member access");
  expectStatus(await member.request(serverBannerPath), 200, "legacy absolute server banner URL retains member access");
  expectDenied(await outsider.request(clipPath), "legacy absolute clip URL still requires current membership");
  expectDenied(await outsider.request(serverIconPath), "legacy absolute server icon URL still requires current membership");
  expectDenied(await outsider.request(serverBannerPath), "legacy absolute server banner URL still requires current membership");
  console.log("PASS legacy absolute clip/server media URLs resolve by exact path and keep current membership checks");

  // Soft deletion must invalidate media for the exact prior URL.
  expectStatus(await member.request(`/api/channels/${restricted.id}/messages/${image.message.id}`, {
    method: "DELETE",
  }), 204, "author soft-deletes synthetic image message");
  assert.equal((await member.request(image.path)).status, 404,
    "soft-deleted message attachment stops serving bytes");
  console.log("PASS deleted channel message invalidates its attached image immediately");

  // Measure burst delivery for many tiny authorized inline images, including the
  // DB-backed permission check on each request. This is a broad local guard, not
  // a production capacity benchmark.
  const performanceImages = [];
  for (let index = 0; index < 12; index++) {
    const item = await uploadMessageAttachment(member, restricted.id, `perf-${index}.png`, png, "image/png");
    performanceImages.push(item.path);
  }
  const irrelevantUrlPrefix = `auth-benchmark-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  executeIsolatedSql(
    `INSERT INTO message_attachments
       (message_id, url, filename, mime_type, size, uploaded_by_user_id, channel_id, claimed)
     SELECT NULL,
            '/api/uploads/${irrelevantUrlPrefix}-' || item_id || '.png',
            '${irrelevantUrlPrefix}-' || item_id || '.png',
            'image/png', 9, ${Number(memberLogin.id)}, ${Number(restricted.id)}, FALSE
     FROM generate_series(1, 5000) AS generated(item_id)`,
    env,
  );
  console.log("PASS inserted 5000 unrelated media-reference rows into the migrated disposable database");
  const startedAt = performance.now();
  const perImageLatency = [];
  const burst = await Promise.all(performanceImages.map(async url => {
    const start = performance.now();
    const response = await member.request(url);
    perImageLatency.push(performance.now() - start);
    return response;
  }));
  const elapsedMs = performance.now() - startedAt;
  perImageLatency.sort((left, right) => left - right);
  const p95Ms = perImageLatency[Math.ceil(perImageLatency.length * 0.95) - 1];
  assert.ok(burst.every(response => response.status === 200 && response.result.equals(png)),
    "all synthetic inline images remain readable in a concurrent load");
  assert.ok(elapsedMs < 10_000, `12 concurrent authorized image requests took ${elapsedMs.toFixed(0)}ms`);
  assert.ok(p95Ms < 5_000, `12-image request p95 was ${p95Ms.toFixed(0)}ms`);
  console.log(`PASS 12 concurrent authorized channel images loaded with 5000 irrelevant media rows in ${elapsedMs.toFixed(0)}ms total (p95 ${p95Ms.toFixed(0)}ms) on disposable local API/DB`);

  if (ffmpegPath) {
    const browserAttachment = await uploadMessageAttachment(
      member, restricted.id, "browser-smoke.png", browserPng, "image/png",
    );
    avatarPath = await uploadProfileImage("/api/users/me/avatar", "browser-avatar", browserPng);
    userBannerPath = await uploadProfileImage("/api/users/me/banner", "browser-banner", browserPng);
    serverIconPath = await uploadServerImage(`/api/servers/${serverId}/icon`, "browser-icon", browserPng);
    serverBannerPath = await uploadServerImage(`/api/servers/${serverId}/banner`, "browser-banner", browserPng);
    await runHeadlessMediaSmoke({
      base,
      cookies: member.cookies,
      imageAssets: [
        { label: "private channel attachment", path: browserAttachment.path },
        { label: "user avatar", path: avatarPath },
        { label: "user banner", path: userBannerPath },
        { label: "server icon", path: serverIconPath },
        { label: "server banner", path: serverBannerPath },
      ],
      noStoreAttachmentPath: browserAttachment.path,
      lowSensitivityPaths: [avatarPath, userBannerPath, serverIconPath, serverBannerPath],
      videoPath: clipPath,
    });
  } else {
    console.log("LIMITATION headless Chromium media-element smoke test not verified because ffmpeg did not generate valid fixtures");
  }

  // Message attachments are not currently supported by direct-message or group
  // message schemas/routes. Record this explicit absence instead of pretending
  // those unsupported attachment kinds were tested.
  console.log("LIMITATION DM/group DM message attachment upload/rendering is not implemented; no such attachment bytes exist to authorize");

  // Simulate expulsion in this disposable DB; direct URL remains identical.
  const escapedMemberId = Number(memberLogin.id);
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(pgPort), "-U", os.userInfo().username,
    "-d", databaseName,
    "-X", "-q", "-v", "ON_ERROR_STOP=1",
    "-c", `DELETE FROM server_members WHERE server_id = ${Number(serverId)} AND user_id = ${escapedMemberId}`,
  ], { env });
  expectDenied(await member.request(image.path), "expelled member loses exact message-image URL");
  expectDenied(await member.request(image.path, {
    headers: { "If-None-Match": authorizedImage.headers.get("etag") },
  }), "expelled member cannot use a matching attachment validator to receive 304");
  expectDenied(await member.request(filePath), "expelled member loses exact library-file URL");
  expectDenied(await member.request(filePath, {
    headers: { "If-None-Match": libraryDownload.headers.get("etag") },
  }), "expelled member cannot use a matching library validator to receive 304");
  expectDenied(await member.request(clipPath), "expelled member loses exact clip URL");
  expectDenied(await member.request(clipPath, {
    headers: { "If-None-Match": authorizedClip.headers.get("etag") },
  }), "expelled member cannot use a matching clip validator to receive 304");
  expectDenied(await member.request(soundboardAudioPath, {
    headers: { "If-None-Match": authorizedSoundboard.headers.get("etag") },
  }), "expelled member cannot use a matching soundboard validator to receive 304");
  expectDenied(await member.request(serverIconPath), "expelled member loses exact server-icon URL");
  expectDenied(await member.request(serverIconPath, {
    headers: { "If-None-Match": (await owner.request(serverIconPath)).headers.get("etag") },
  }), "expelled member cannot use a matching server-icon validator to receive 304");
  expectDenied(await member.request(serverBannerPath), "expelled member loses exact server-banner URL");
  expectDenied(await member.request(serverIconPath, { method: "HEAD" }),
    "expelled member cannot bypass server-icon revocation using HEAD");
  expectDenied(await member.request(serverBannerPath, { headers: { Range: "bytes=0-7" } }),
    "expelled member cannot bypass server-banner revocation using Range");
  expectStatus(await member.request(avatarPath), 200,
    "profile avatar remains visible to its signed-in owner after leaving a server");
  expectDenied({ status: (await fetch(base + avatarPath)).status },
    "profile avatar remains inaccessible without a session after server membership changes");
  console.log("PASS removing membership in disposable PostgreSQL revokes message, library, and clip URLs");
} finally {
  await cleanup();
  console.log("PASS isolated API, PostgreSQL, all sessions/accounts/files removed from /tmp");
}