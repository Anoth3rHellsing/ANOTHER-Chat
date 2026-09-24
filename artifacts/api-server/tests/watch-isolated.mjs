// Only for a disposable API on port 4011 backed by an isolated temporary DB.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const base = process.env.WATCH_TEST_BASE;
if (base !== "http://127.0.0.1:4011") throw new Error("This test is restricted to the isolated test API.");

function account() {
  const cookies = new Map();
  const request = async (url, { method = "GET", data } = {}) => {
    const headers = {};
    if (cookies.size) headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (data !== undefined) headers["Content-Type"] = "application/json";
    if (cookies.has("csrf_token") && method !== "GET") headers["x-csrf-token"] = cookies.get("csrf_token");
    const res = await fetch(base + url, {
      method, headers, body: data === undefined ? undefined : JSON.stringify(data),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const raw = await res.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = raw; }
    assert.ok(res.ok, `${method} ${url} returned ${res.status}: ${JSON.stringify(payload)}`);
    return payload;
  };
  return { request, cookies };
}

function waitFor(ws, test, label, timeout = 4500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", listener);
      reject(new Error(`No ${label} received`));
    }, timeout);
    function listener(raw) {
      const message = JSON.parse(raw.toString());
      if (!test(message)) return;
      clearTimeout(timer);
      ws.off("message", listener);
      resolve(message);
    }
    ws.on("message", listener);
  });
}

async function connect(account) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws", {
    headers: { Cookie: [...account.cookies].map(([key, value]) => `${key}=${value}`).join("; ") },
  });
  const connected = waitFor(ws, m => m.type === "connected", "connected");
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  await connected;
  return ws;
}

const context = async () => {
  const a = account(), b = account();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const password = `Disposable-${randomUUID()}!`;
  await a.request("/api/auth/register", {
    method: "POST", data: { username: `watch_a_${suffix}`, password, displayName: "Test Host" },
  });
  const first = await a.request("/api/auth/me");
  const firstId = first.id ?? first.user?.id;
  const server = await a.request("/api/servers", {
    method: "POST", data: { name: "Isolated Watch Test" },
  });
  const registration = await a.request("/api/admin/invites", { method: "POST", data: {} });
  await b.request("/api/auth/register", {
    method: "POST", data: {
      username: `watch_b_${suffix}`, password: `Disposable-${randomUUID()}!`,
      displayName: "Test Listener", inviteCode: registration.code,
    },
  });
  const second = await b.request("/api/auth/me");
  const secondId = second.id ?? second.user?.id;
  const invite = await a.request(`/api/servers/${server.id}/invites`, { method: "POST", data: {} });
  await b.request("/api/servers/join-by-invite", { method: "POST", data: { code: invite.code } });
  const channel = await a.request(`/api/servers/${server.id}/channels`, {
    method: "POST", data: { name: "watch-test-voice", channelType: "voice" },
  });
  assert.ok(firstId && secondId && channel.id);
  return { a, b, firstId, secondId, channelId: channel.id };
};

const youtube = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5";
const soundcloud = "https://soundcloud.com/example/track-example?utm_source=test";
const args = (scope, targetId) => ({ scope, targetId });
let aWs, bWs, extraTab;
try {
  const { a, b, firstId, secondId, channelId } = await context();
  aWs = await connect(a);
  bWs = await connect(b);
  extraTab = await connect(a);
  let unboundStateCount = 0;
  extraTab.on("message", raw => {
    if (JSON.parse(raw.toString()).type === "watch:state") unboundStateCount += 1;
  });
  await a.request(`/api/channels/${channelId}/voice/join`, { method: "POST", data: {} });
  const boundA = waitFor(aWs, m => m.type === "voice:bound", "first voice bind");
  aWs.send(JSON.stringify({ type: "voice:bind", channelId }));
  await boundA;

  const stateA = waitFor(aWs, m => m.type === "watch:state" && m.data?.session?.current,
    "host session state");
  aWs.send(JSON.stringify({ type: "watch:start", ...args("voice", channelId), url: youtube }));
  const started = (await stateA).data.session;
  assert.equal(started.current.platform, "youtube");
  assert.equal(started.current.contentId, "dQw4w9WgXcQ");
  assert.equal(started.controllerUserId, firstId);
  console.log("PASS voice host starts canonical YouTube session");

  const invalid = waitFor(aWs, m => m.type === "watch:error", "invalid-origin error");
  aWs.send(JSON.stringify({ type: "watch:add", ...args("voice", channelId),
    url: "https://www.youtube.com.evil.invalid/watch?v=dQw4w9WgXcQ" }));
  assert.match((await invalid).data.message, /enlace|dominio|permitid|youtube|soundcloud|origen/i);
  console.log("PASS non-platform domain rejected with visible server error");

  const queued = waitFor(aWs, m => m.type === "watch:state" && m.data?.session?.queue.length === 1,
    "shared queue update");
  aWs.send(JSON.stringify({ type: "watch:add", ...args("voice", channelId), url: soundcloud }));
  const track = (await queued).data.session.queue[0];
  assert.equal(track.platform, "soundcloud");
  assert.equal(track.contentId, "example/track-example");
  assert.equal(track.canonicalUrl, "https://soundcloud.com/example/track-example");
  console.log("PASS SoundCloud permalink normalized and queued");

  await b.request(`/api/channels/${channelId}/voice/join`, { method: "POST", data: {} });
  const boundB = waitFor(bWs, m => m.type === "voice:bound", "late voice bind");
  const lateState = waitFor(bWs, m => m.type === "watch:state" && m.data?.session?.current,
    "late join snapshot");
  bWs.send(JSON.stringify({ type: "voice:bind", channelId }));
  await boundB;
  const late = (await lateState).data.session;
  assert.equal(late.current.contentId, "dQw4w9WgXcQ");
  assert.equal(late.queue[0].id, track.id);
  console.log("PASS late voice participant receives current item and queue");
  const twoQueued = waitFor(aWs, m => m.type === "watch:state" && m.data?.session?.queue.length === 2,
    "both platforms queued");
  bWs.send(JSON.stringify({ type: "watch:add", ...args("voice", channelId), url: youtube }));
  const secondQueue = (await twoQueued).data.session.queue;
  const queuedVideo = secondQueue[1];
  assert.equal(queuedVideo.platform, "youtube");
  assert.equal(queuedVideo.addedById, secondId);
  assert.equal(queuedVideo.addedByName, "Test Listener");
  assert.equal(secondQueue[0].addedById, firstId);
  console.log("PASS both platforms queued with their authors and updated count");
  const unbound = waitFor(extraTab, m => m.type === "watch:error", "unbound tab rejection");
  extraTab.send(JSON.stringify({ type: "watch:sync", ...args("voice", channelId) }));
  assert.match((await unbound).data.message, /conectado|vinculad|llamada/i);
  assert.equal(unboundStateCount, 0);
  console.log("PASS same-account unbound tab neither controls nor receives voice session");

  const noControl = waitFor(bWs, m => m.type === "watch:error", "non-controller rejection");
  bWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId), action: "pause" }));
  assert.match((await noControl).data.message, /control|permiso|anfitri|autoriza/i);
  console.log("PASS non-controller cannot pause");

  for (const [action, positionMs, expectedPlaying] of [
    ["pause", undefined, false], ["seek", 17_000, false], ["play", undefined, true],
  ]) {
    const changed = waitFor(bWs, m => m.type === "watch:state"
      && m.data?.session?.playing === expectedPlaying
      && (positionMs === undefined || m.data.session.positionMs === positionMs)
      && (action !== "play" || m.data.session.positionMs >= 17_000), `${action} replication`);
    aWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId), action,
      ...(positionMs === undefined ? {} : { positionMs }) }));
    await changed;
    console.log(`PASS ${action} reflected on peer`);
  }

  const everyone = waitFor(bWs, m => m.type === "watch:state" && m.data?.session?.allowEveryone,
    "everyone control update");
  aWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId),
    action: "everyone", allowEveryone: true }));
  await everyone;
  const listenerPause = waitFor(aWs, m => m.type === "watch:state" && m.data?.session?.playing === false,
    "delegated pause");
  bWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId), action: "pause" }));
  await listenerPause;
  console.log("PASS participants can control when host allows it");

  const transfer = waitFor(bWs, m => m.type === "watch:state"
    && m.data?.session?.controllerUserId === secondId, "control transfer");
  aWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId),
    action: "transfer", userId: secondId }));
  await transfer;
  const reordered = waitFor(aWs, m => m.type === "watch:state"
    && m.data?.session?.queue[0]?.id === queuedVideo.id, "queue reorder");
  bWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId),
    action: "reorder", itemId: queuedVideo.id, toIndex: 0 }));
  assert.equal((await reordered).data.session.queue[1].id, track.id);
  console.log("PASS controller reorders pending items");
  const removed = waitFor(aWs, m => m.type === "watch:state"
    && m.data?.session?.queue.length === 1, "queue remove");
  bWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId),
    action: "remove", itemId: queuedVideo.id }));
  assert.equal((await removed).data.session.queue[0].id, track.id);
  console.log("PASS controller removes a pending item");
  const next = waitFor(aWs, m => m.type === "watch:state"
    && m.data?.session?.current?.platform === "soundcloud", "advance queue");
  bWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId), action: "skip" }));
  const currentTrack = (await next).data.session.current;
  console.log("PASS transfer and advancing to SoundCloud track");
  const queuedAfterSkip = waitFor(aWs, m => m.type === "watch:state"
    && m.data?.session?.queue.length === 1, "next track queued");
  bWs.send(JSON.stringify({ type: "watch:add", ...args("voice", channelId), url: youtube }));
  await queuedAfterSkip;
  const autoAdvance = waitFor(aWs, m => m.type === "watch:state"
    && m.data?.session?.current?.platform === "youtube"
    && m.data.session.queue.length === 0, "automatic advance at track end");
  bWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId),
    action: "ended", itemId: currentTrack.id }));
  await autoAdvance;
  console.log("PASS track end advances automatically to the next queued item");

  const ended = waitFor(aWs, m => m.type === "watch:state" && m.data?.session === null, "session end");
  bWs.send(JSON.stringify({ type: "watch:control", ...args("voice", channelId), action: "end" }));
  await ended;
  console.log("PASS host ends session and clears shared state");

  const again = waitFor(aWs, m => m.type === "watch:state" && m.data?.session?.current,
    "second temporary session");
  aWs.send(JSON.stringify({ type: "watch:start", ...args("voice", channelId), url: youtube }));
  await again;
  const handoff = waitFor(bWs, m => m.type === "watch:state"
    && m.data?.session?.controllerUserId === secondId, "voice host departure transfer");
  aWs.send(JSON.stringify({ type: "voice:unbind", channelId }));
  await handoff;
  console.log("PASS remaining participant takes control when voice host leaves");
  bWs.send(JSON.stringify({ type: "voice:unbind", channelId }));
  await a.request(`/api/channels/${channelId}/voice/join`, { method: "POST", data: {} });
  const rebound = waitFor(aWs, m => m.type === "watch:state"
    && m.data?.scope === "voice" && m.data.session === null, "automatic voice session cleanup");
  aWs.send(JSON.stringify({ type: "voice:bind", channelId }));
  await rebound;
  console.log("PASS session disappears when last bound voice participant leaves");

  const invited = waitFor(bWs, m => m.type === "dm:call-invite", "direct-call invitation");
  aWs.send(JSON.stringify({ type: "dm:call-invite", recipientId: secondId, callerName: "Test Host" }));
  await invited;
  const accepted = waitFor(aWs, m => m.type === "dm:call-accepted", "direct-call accepted");
  bWs.send(JSON.stringify({ type: "dm:call-answer", callerId: firstId }));
  await accepted;
  const dmState = waitFor(bWs, m => m.type === "watch:state" && m.data?.session?.current,
    "direct-call watch state");
  aWs.send(JSON.stringify({ type: "watch:start", ...args("dm", secondId), url: soundcloud }));
  assert.equal((await dmState).data.session.current.platform, "soundcloud");
  const wrongTab = waitFor(extraTab, m => m.type === "watch:error", "non-call tab rejection");
  extraTab.send(JSON.stringify({ type: "watch:sync", ...args("dm", secondId) }));
  assert.match((await wrongTab).data.message, /conectado|vinculad|llamada/i);
  assert.equal(unboundStateCount, 0);
  console.log("PASS answered direct call excludes other tabs of the same user");
  const callEnded = waitFor(bWs, m => m.type === "watch:state"
    && m.data?.scope === "dm" && m.data?.session === null, "direct-call cleanup");
  aWs.send(JSON.stringify({ type: "dm:call-end", targetUserId: secondId }));
  await callEnded;
  console.log("PASS direct-call session ends on hangup");
} finally {
  aWs?.close();
  bWs?.close();
  extraTab?.close();
}