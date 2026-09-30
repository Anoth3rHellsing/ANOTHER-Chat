// Fase 0.3: el baneo global corta las sesiones y los sockets en el acto.
// Antes, /admin/users/:id/ban marcaba users.banned, pero requireAuth solo
// miraba la sesión y el WebSocket seguía abierto: el baneado seguía usando
// la app hasta cerrar sesión.
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { account, expectStatus, registerAdminAndMembers, startIsolatedApi } from "./helpers/isolated-api.mjs";

const sockets = new Set();

async function openSocket(base, client) {
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", {
    headers: { Cookie: client.cookieHeader() },
  });
  sockets.add(ws);
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for an authenticated WebSocket")), 5000);
    ws.on("message", raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "connected") { clearTimeout(timer); resolve(message); }
    });
    ws.once("close", code => { clearTimeout(timer); reject(new Error(`socket closed before authenticating (${code})`)); });
    ws.once("error", reject);
  });
  await connected;
  return ws;
}

function closeCode(ws, timeoutMs = 5000) {
  return Promise.race([
    once(ws, "close").then(([code]) => code),
    new Promise((_, reject) => setTimeout(() => reject(new Error("socket was not closed")), timeoutMs)),
  ]);
}

const api = await startIsolatedApi("global_ban");
try {
  const { base, sql } = api;
  const { admin, members: [target, bystander] } = await registerAdminAndMembers(base, "ban", 2);
  assert.notEqual(target.user.id, bystander.user.id);

  const sessionsOf = userId => Number(sql(`SELECT count(*) FROM sessions WHERE sess->>'userId' = '${userId}'`)[0]);

  // Una segunda sesión del mismo usuario (otro dispositivo) también debe caer.
  const secondDevice = account(base);
  const targetPassword = target.password;
  expectStatus(await secondDevice.request("/api/auth/login", {
    method: "POST", json: { username: target.user.username, password: targetPassword },
  }), 200, "log in from a second device");
  assert.ok(sessionsOf(target.user.id) >= 2, "the target has at least two sessions before the ban");
  const bystanderSessions = sessionsOf(bystander.user.id);
  assert.ok(bystanderSessions >= 1, "the bystander has a session");

  const targetSocket = await openSocket(base, target.client);
  const secondSocket = await openSocket(base, secondDevice);
  const bystanderSocket = await openSocket(base, bystander.client);
  expectStatus(await target.client.request("/api/auth/me"), 200, "the target is signed in before the ban");

  // 1. Un miembro no administrador no puede banear.
  {
    const response = await bystander.client.request(`/api/admin/users/${target.user.id}/ban`, { method: "POST" });
    assert.equal(response.status, 403, `a non-admin cannot ban, got ${response.status}`);
    assert.equal(sql(`SELECT banned FROM users WHERE id = ${target.user.id}`)[0], "f");
    console.log("PASS a non-admin member cannot ban");
  }

  // 2. Banear corta sesiones y sockets en el acto.
  {
    const targetClosed = closeCode(targetSocket);
    const secondClosed = closeCode(secondSocket);
    expectStatus(await admin.request(`/api/admin/users/${target.user.id}/ban`, { method: "POST" }), 204, "ban the target");
    assert.equal(await targetClosed, 4003, "the target's socket closes with the banned code");
    assert.equal(await secondClosed, 4003, "the second device's socket closes too");
    assert.equal(sessionsOf(target.user.id), 0, "every session of the banned user is deleted");
    console.log("PASS banning closes every socket of the user with code 4003 and deletes every session");

    const next = await target.client.request("/api/auth/me");
    assert.ok([401, 403].includes(next.status), `the banned user's next request is rejected, got ${next.status}`);
    const otherDevice = await secondDevice.request("/api/servers");
    assert.ok([401, 403].includes(otherDevice.status), `the second device is rejected too, got ${otherDevice.status}`);
    console.log("PASS the banned user's next HTTP requests are rejected on every device");
  }

  // 3. Nadie más pierde nada.
  {
    assert.equal(sessionsOf(bystander.user.id), bystanderSessions, "other users keep their sessions");
    assert.equal(bystanderSocket.readyState, WebSocket.OPEN, "other users keep their sockets");
    expectStatus(await bystander.client.request("/api/auth/me"), 200, "the bystander is still signed in");
    expectStatus(await admin.request("/api/auth/me"), 200, "the admin is still signed in");
    console.log("PASS other users keep their sessions and sockets");
  }

  // 4. No puede volver a entrar ni abrir sockets.
  {
    const login = await secondDevice.request("/api/auth/login", {
      method: "POST", json: { username: target.user.username, password: targetPassword },
    });
    assert.equal(login.status, 403);
    assert.match(login.result.error, /baneada/);
    await assert.rejects(openSocket(base, target.client), /closed before authenticating|Timed out/);
    console.log("PASS a banned user can neither log in nor open a socket");
  }

  // 5. Defensa en profundidad: una sesión que sobreviva al borrado no sirve.
  {
    expectStatus(await admin.request(`/api/admin/users/${target.user.id}/unban`, { method: "POST" }), 204, "unban");
    const fresh = account(base);
    expectStatus(await fresh.request("/api/auth/login", {
      method: "POST", json: { username: target.user.username, password: targetPassword },
    }), 200, "log in again after the unban");
    // Se marca el baneo sin pasar por la ruta, como si la sesión hubiera sobrevivido.
    sql(`UPDATE users SET banned = true WHERE id = ${target.user.id}`);
    // Primero el socket: la petición HTTP rechazada destruye la sesión.
    assert.equal(sql(`SELECT count(*) FROM sessions WHERE sess->>'userId' = '${target.user.id}'`)[0], "1", "the session is still live");
    await assert.rejects(openSocket(base, fresh), /closed before authenticating|Timed out/, "a live session of a banned account cannot open a socket");
    const response = await fresh.request("/api/servers");
    assert.equal(response.status, 403, `requireAuth rejects a banned account with a live session, got ${response.status}`);
    assert.match(response.result.error, /baneada/);
    assert.equal(sessionsOf(target.user.id), 0, "the rejected session is destroyed");
    console.log("PASS requireAuth and the WebSocket reject a banned account even with a live session");
  }

  // 6. Id inválido.
  {
    const response = await admin.request("/api/admin/users/abc/ban", { method: "POST" });
    assert.equal(response.status, 400);
    console.log("PASS an invalid user id returns 400");
  }

  console.log("PASS all global ban checks passed");
} finally {
  for (const ws of sockets) ws.terminate();
  await api.stop();
}
