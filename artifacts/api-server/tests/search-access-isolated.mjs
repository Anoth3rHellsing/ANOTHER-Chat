// Fase 0.2: la búsqueda respeta los canales restringidos.
// Antes, /servers/:id/search y /channels/:id/search solo comprobaban que el
// usuario fuera miembro del servidor, así que un miembro sin el rol leía en
// los resultados los mensajes de los canales restringidos.
import assert from "node:assert/strict";
import { expectStatus, registerAdminAndMembers, startIsolatedApi } from "./helpers/isolated-api.mjs";

const api = await startIsolatedApi("search_access");
try {
  const { base } = api;
  const { admin, members: [withoutRole, withRole, outsider] } = await registerAdminAndMembers(base, "search", 3);

  for (let index = 0; index < 5; index += 1) {
    expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: `Relleno ${index}` } }), 201, "create filler server");
  }
  const server = expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: "Búsqueda" } }), 201, "create server");
  const otherServer = expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: "Otro" } }), 201, "create other server");
  for (const { user } of [withoutRole, withRole, outsider]) {
    assert.notEqual(server.id, user.id, "server id must differ from every member id");
  }

  for (const member of [withoutRole, withRole]) {
    const invite = expectStatus(await admin.request(`/api/servers/${server.id}/invites`, { method: "POST", json: {} }), 201, "create invite");
    expectStatus(await member.client.request("/api/servers/join-by-invite", { method: "POST", json: { code: invite.code } }), 200, "join server");
  }
  const otherInvite = expectStatus(await admin.request(`/api/servers/${otherServer.id}/invites`, { method: "POST", json: {} }), 201, "create other invite");
  expectStatus(await outsider.client.request("/api/servers/join-by-invite", { method: "POST", json: { code: otherInvite.code } }), 200, "outsider joins the other server");

  const role = expectStatus(await admin.request(`/api/servers/${server.id}/roles`, {
    method: "POST", json: { name: "Consejo", permissions: 0 },
  }), 201, "create role");
  assert.notEqual(role.id, server.id, "role id must differ from server id");
  expectStatus(await admin.request(`/api/servers/${server.id}/members/${withRole.user.id}/roles/${role.id}`, {
    method: "POST", json: {},
  }), 200, "assign the role");

  const restricted = expectStatus(await admin.request(`/api/servers/${server.id}/channels`, {
    method: "POST", json: { name: "consejo", channelType: "text", restrictedRoles: [role.id] },
  }), 201, "create restricted channel");
  const open = expectStatus(await admin.request(`/api/servers/${server.id}/channels`, {
    method: "POST", json: { name: "abierto", channelType: "text" },
  }), 201, "create open channel");

  expectStatus(await admin.request(`/api/channels/${restricted.id}/messages`, {
    method: "POST", json: { content: "la contraseña del wifi es zanahoriasecreta" },
  }), 201, "post in restricted channel");
  expectStatus(await admin.request(`/api/channels/${open.id}/messages`, {
    method: "POST", json: { content: "mañana jugamos zanahoriapublica" },
  }), 201, "post in open channel");

  const serverSearch = (client, term) => client.request(`/api/servers/${server.id}/search?q=${encodeURIComponent(term)}`);

  // 1. Búsqueda en el servidor sin el rol: nada del canal restringido.
  {
    const results = expectStatus(await serverSearch(withoutRole.client, "zanahoriasecreta"), 200, "server search without role");
    assert.equal(results.length, 0, "a member without the role gets no results from the restricted channel");
    const broad = expectStatus(await serverSearch(withoutRole.client, "zanahoria"), 200, "broad server search without role");
    assert.deepEqual(broad.map(result => result.channelId), [open.id], "only the open channel appears for a member without the role");
    console.log("PASS server search hides restricted channels from members without the role");
  }

  // 2. Con el rol, sí aparece.
  {
    const results = expectStatus(await serverSearch(withRole.client, "zanahoriasecreta"), 200, "server search with role");
    assert.equal(results.length, 1, "a member with the role finds the restricted message");
    assert.equal(results[0].channelId, restricted.id);
    console.log("PASS server search includes restricted channels for members with the role");
  }

  // 3. Búsqueda dentro del canal restringido sin el rol: 403.
  {
    const response = await withoutRole.client.request(`/api/channels/${restricted.id}/search?q=zanahoria`);
    assert.equal(response.status, 403, `channel search without the role must be 403, got ${response.status}`);
    const allowed = expectStatus(await withRole.client.request(`/api/channels/${restricted.id}/search?q=zanahoria`), 200, "channel search with role");
    assert.equal(allowed.length, 1);
    console.log("PASS channel search requires access to the channel");
  }

  // 4. Alguien de otro servidor no busca en este.
  {
    assert.equal((await serverSearch(outsider.client, "zanahoria")).status, 403, "a member of another server cannot search this server");
    assert.equal((await outsider.client.request(`/api/channels/${open.id}/search?q=zanahoria`)).status, 403, "nor its channels");
    console.log("PASS members of another server cannot search this server");
  }

  console.log("PASS all search access checks passed");
} finally {
  await api.stop();
}
