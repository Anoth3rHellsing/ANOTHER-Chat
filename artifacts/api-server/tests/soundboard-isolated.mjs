// Run only against an isolated, disposable API instance backed by a temporary DB.
// Never point this script at the project's development or published API.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const base = process.env.SOUNDBOARD_TEST_BASE;
if (base !== "http://127.0.0.1:4010") throw new Error("Run only on the isolated port 4010.");

function account() {
  const cookies = new Map();
  return async (url, { method = "GET", json, body } = {}) => {
    const headers = {};
    if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookies.has("csrf_token") && method !== "GET") headers["x-csrf-token"] = cookies.get("csrf_token");
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(base + url, {
      method, headers, body: body ?? (json === undefined ? undefined : JSON.stringify(json)),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const part = cookie.split(";")[0];
      const offset = part.indexOf("=");
      if (offset > 0) cookies.set(part.slice(0, offset), part.slice(offset + 1));
    }
    const raw = await response.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = raw; }
    return { status: response.status, headers: response.headers, result, cookies };
  };
}

function expectStatus(response, status, description) {
  assert.equal(response.status, status, `${description}: ${JSON.stringify(response.result)}`);
  console.log(`PASS ${description} (${status})`);
  return response.result;
}

function waitFor(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off("message", onMessage); reject(new Error(`No ${type} event`)); }, timeout);
    function onMessage(raw) {
      const data = JSON.parse(raw.toString());
      if (data.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(data);
    }
    ws.on("message", onMessage);
  });
}

async function connect(cookies) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", {
    headers: { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  const connected = waitFor(ws, "connected");
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await connected;
  return ws;
}

const dir = await mkdtemp(path.join(os.tmpdir(), "soundboard-fixtures-"));
let aWs, bWs;
try {
  const a = account(), b = account();
  const usernameA = `iso_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const usernameB = `iso_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const passA = `Disposable-${randomUUID()}!`;
  const passB = `Disposable-${randomUUID()}!`;
  expectStatus(await a("/api/auth/register", { method: "POST", json: {
    username: usernameA, password: passA, displayName: "Temporary Owner",
  } }), 201, "register temporary owner in isolated database");
  const meA = expectStatus(await a("/api/auth/me"), 200, "authenticate temporary owner");
  const aId = meA.id ?? meA.user?.id;
  const createdServer = expectStatus(await a("/api/servers", { method: "POST", json: {
    name: "Isolated Soundboard Server",
  } }), 201, "create isolated server");
  const serverId = createdServer.id ?? createdServer.server?.id;
  const registrationInvite = expectStatus(await a("/api/admin/invites", {
    method: "POST", json: {},
  }), 201, "create isolated registration invitation");
  const code = registrationInvite.code;
  expectStatus(await b("/api/auth/register", { method: "POST", json: {
    username: usernameB, password: passB, displayName: "Temporary Peer", inviteCode: code,
  } }), 201, "register temporary peer");
  const meB = expectStatus(await b("/api/auth/me"), 200, "authenticate temporary peer");
  const bId = meB.id ?? meB.user?.id;
  assert.ok(Number.isInteger(aId) && Number.isInteger(bId) && serverId);
  const serverInvite = expectStatus(await a(`/api/servers/${serverId}/invites`, {
    method: "POST", json: {},
  }), 201, "create isolated server invitation");
  expectStatus(await b("/api/servers/join-by-invite", {
    method: "POST", json: { code: serverInvite.code },
  }), 200, "peer joins isolated server");

  const goodFile = path.join(dir, "short.mp3");
  const longFile = path.join(dir, "long.mp3");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-b:a", "64k", "-y", goodFile]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-b:a", "64k", "-y", longFile]);
  const oversized = path.join(dir, "oversized.wav");
  await writeFile(oversized, Buffer.alloc(256 * 1024 + 1, 0));
  const invalid = path.join(dir, "invalid.mp3");
  await writeFile(invalid, "not audio");
  async function upload(client, file, name) {
    const form = new FormData();
    form.append("name", name);
    form.append("file", new Blob([await readFile(file)]), path.basename(file));
    return client(`/api/servers/${serverId}/soundboard`, { method: "POST", body: form });
  }
  const clip = expectStatus(await upload(a, goodFile, "Test tone"), 201, "valid 1-second audio upload");
  assert.ok(clip.id && clip.durationMs > 0 && clip.durationMs <= 5000);
  const fileResponse = await a(clip.url);
  expectStatus(fileResponse, 200, "uploaded audio is fetchable");
  assert.equal(fileResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(fileResponse.headers.get("content-disposition") ?? "", /attachment/i);
  console.log("PASS uploaded audio retains hardened file headers");
  expectStatus(await account()(clip.url), 401, "clip audio cannot be downloaded without login");
  expectStatus(await account()("/api/uploads/soundboard-guess.mp3"), 404,
    "public upload route blocks soundboard files");
  const badType = await upload(a, invalid, "Fake audio");
  expectStatus(badType, 400, "fake MP3 is rejected by content verification");
  assert.match(badType.result.error, /signature|format|audio/i);
  const tooLong = await upload(a, longFile, "Long tone");
  expectStatus(tooLong, 400, "audio longer than five seconds is rejected");
  assert.match(tooLong.result.error, /5 seconds/i);
  const tooBig = await upload(a, oversized, "Big tone");
  expectStatus(tooBig, 413, "audio larger than 256 KiB is rejected");
  assert.match(tooBig.result.error, /256 KiB/i);
  expectStatus(await upload(b, goodFile, "Forbidden"), 403, "ordinary member cannot upload");
  expectStatus(await b(`/api/servers/${serverId}/soundboard/${clip.id}`, {
    method: "DELETE",
  }), 403, "ordinary member cannot delete owner's clip");

  const voice = expectStatus(await a(`/api/servers/${serverId}/channels`, {
    method: "POST", json: { name: "test-voice", channelType: "voice" },
  }), 201, "create isolated voice channel");
  const channelId = voice.id ?? voice.channel?.id;
  assert.ok(channelId);
  aWs = await connect((await a("/api/auth/me")).cookies);
  bWs = await connect((await b("/api/auth/me")).cookies);
  expectStatus(await a(`/api/channels/${channelId}/voice/join`, {
    method: "POST", json: {},
  }), 200, "first account joins voice");
  expectStatus(await b(`/api/channels/${channelId}/voice/join`, {
    method: "POST", json: {},
  }), 200, "second account joins voice");
  const aBound = waitFor(aWs, "voice:bound");
  const bBound = waitFor(bWs, "voice:bound");
  aWs.send(JSON.stringify({ type: "voice:bind", channelId }));
  bWs.send(JSON.stringify({ type: "voice:bind", channelId }));
  await Promise.all([aBound, bBound]);
  const voiceEvent = waitFor(bWs, "soundboard:play");
  expectStatus(await a("/api/soundboard/trigger", {
    method: "POST", json: { clipId: clip.id, callType: "voice", channelId },
  }), 200, "first voice trigger succeeds");
  const voicePayload = (await voiceEvent).data;
  assert.equal(voicePayload.clipId, clip.id);
  assert.equal(voicePayload.triggeredById, aId);
  assert.equal(voicePayload.channelId, channelId);
  console.log("PASS active voice peer receives clip ID, URL and triggering user through existing WS");
  expectStatus(await a("/api/soundboard/trigger", {
    method: "POST", json: { clipId: clip.id, callType: "voice", channelId },
  }), 429, "server rejects burst trigger");

  const invited = waitFor(bWs, "dm:call-invite");
  aWs.send(JSON.stringify({ type: "dm:call-invite", recipientId: bId, callerName: "Temporary Owner" }));
  await invited;
  const accepted = waitFor(aWs, "dm:call-accepted");
  bWs.send(JSON.stringify({ type: "dm:call-answer", callerId: aId }));
  await accepted;
  await new Promise(resolve => setTimeout(resolve, 2100));
  const dmEvent = waitFor(bWs, "soundboard:play");
  expectStatus(await a("/api/soundboard/trigger", {
    method: "POST", json: { clipId: clip.id, callType: "dm", peerId: bId },
  }), 200, "active direct call trigger succeeds");
  const dmPayload = (await dmEvent).data;
  assert.equal(dmPayload.peerId, bId);
  assert.equal(dmPayload.triggeredById, aId);
  console.log("PASS exact direct-call peer receives trigger without new socket");
  expectStatus(await a(`/api/servers/${serverId}/soundboard/${clip.id}`, {
    method: "DELETE",
  }), 204, "owner removes uploaded clip");
  expectStatus(await a(clip.url), 404, "deleted clip's authenticated URL no longer works");
  expectStatus(await a(`/api/servers/${serverId}/soundboard`), 200, "clip list remains available after deletion");
} finally {
  aWs?.close();
  bWs?.close();
  await rm(dir, { recursive: true, force: true });
}