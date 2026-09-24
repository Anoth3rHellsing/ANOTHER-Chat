import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import express from "express";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tempDir = await mkdtemp(join(packageRoot, ".tmp-giphy-proxy-test-"));
const bundlePath = join(tempDir, "giphy-route.mjs");
const esbuild = join(packageRoot, "node_modules/.bin/esbuild");
const routePath = join(packageRoot, "src/routes/giphy.ts");
const build = spawnSync(esbuild, [
  routePath, "--bundle", "--packages=external", "--platform=node", "--format=esm", `--outfile=${bundlePath}`,
], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);
const { createGiphyRouter } = await import(pathToFileURL(bundlePath).href);
const API_KEY_FOR_TESTS_ONLY = "not-a-real-upstream-key";
const upstreamCalls = [];
let server;
let origin;

function response(items = 2) {
  return Response.json({
    data: [
      ...Array.from({ length: items }, (_, index) => ({
        id: `gif-${index}`,
        title: `GIF ${index}`,
        images: { fixed_width: { url: `https://media.giphy.com/media/gif-${index}/giphy.gif` } },
      })),
      { id: "untrusted", title: "Untrusted", images: { fixed_width: { url: "https://evil.test/a.gif" } } },
    ],
    pagination: { total_count: 48 },
  });
}

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: 91, userRole: "user" };
    next();
  });
  app.use("/api", createGiphyRouter({
    getApiKey: () => API_KEY_FOR_TESTS_ONLY,
    fetchImpl: async (url, options) => {
      upstreamCalls.push({ url: new URL(url), options });
      return response();
    },
  }));
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
});

test("availability is authenticated and never returns the server secret", async () => {
  const result = await fetch(`${origin}/api/giphy/status`);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(body, { available: true });
  assert.equal(JSON.stringify(body).includes(API_KEY_FOR_TESTS_ONLY), false);
});

test("empty search uses trending, applies the conservative G rating, and filters untrusted media", async () => {
  const result = await fetch(`${origin}/api/giphy/search`);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.rating, "g");
  assert.equal(body.pageSize, 24);
  assert.equal(body.data.length, 2);
  assert.equal(body.nextOffset, 3);
  assert.equal(body.hasMore, true);
  assert.equal(JSON.stringify(body).includes(API_KEY_FOR_TESTS_ONLY), false);
  const call = upstreamCalls.at(-1);
  assert.equal(call.url.pathname, "/v1/gifs/trending");
  assert.equal(call.url.searchParams.get("api_key"), API_KEY_FOR_TESTS_ONLY);
  assert.equal(call.url.searchParams.get("rating"), "g");
  assert.equal(call.url.searchParams.get("limit"), "24");
  assert.equal(call.options.headers.Accept, "application/json");
});

test("a query uses GIPHY search and supports the next offset", async () => {
  const result = await fetch(`${origin}/api/giphy/search?q=happy+cat&offset=24`);
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(upstreamCalls.at(-1).url.pathname, "/v1/gifs/search");
  assert.equal(upstreamCalls.at(-1).url.searchParams.get("q"), "happy cat");
  assert.equal(upstreamCalls.at(-1).url.searchParams.get("offset"), "24");
  assert.equal(body.nextOffset, 27);
  assert.ok(body.data.every(item => item.url.startsWith("https://media.giphy.com/")));
});

test("missing keys report unavailable and never contact the provider", async () => {
  const app = express();
  app.use((req, _res, next) => { req.session = { userId: 92 }; next(); });
  app.use("/api", createGiphyRouter({ getApiKey: () => undefined, fetchImpl: async () => {
    throw new Error("Must not contact GIPHY without a key");
  } }));
  const temporaryServer = app.listen(0);
  await new Promise(resolve => temporaryServer.once("listening", resolve));
  const missingKeyOrigin = `http://127.0.0.1:${temporaryServer.address().port}`;
  try {
    const status = await fetch(`${missingKeyOrigin}/api/giphy/status`);
    assert.deepEqual(await status.json(), {
      available: false,
      message: "Selector de GIF no disponible: falta configurar la clave de GIPHY en el servidor.",
    });
    const search = await fetch(`${missingKeyOrigin}/api/giphy/search`);
    assert.equal(search.status, 503);
    assert.equal(JSON.stringify(await search.json()).includes(API_KEY_FOR_TESTS_ONLY), false);
  } finally {
    await new Promise(resolve => temporaryServer.close(resolve));
  }
});

test("search requests are rate limited per authenticated user", async () => {
  const app = express();
  app.use((req, _res, next) => { req.session = { userId: 93 }; next(); });
  app.use("/api", createGiphyRouter({
    getApiKey: () => API_KEY_FOR_TESTS_ONLY,
    fetchImpl: async () => response(1),
  }));
  const temporaryServer = app.listen(0);
  await new Promise(resolve => temporaryServer.once("listening", resolve));
  const limitedOrigin = `http://127.0.0.1:${temporaryServer.address().port}`;
  try {
    const statuses = [];
    for (let index = 0; index < 13; index += 1) {
      statuses.push((await fetch(`${limitedOrigin}/api/giphy/search`)).status);
    }
    assert.equal(statuses.filter(status => status === 200).length, 12);
    assert.equal(statuses.at(-1), 429);
  } finally {
    await new Promise(resolve => temporaryServer.close(resolve));
  }
});