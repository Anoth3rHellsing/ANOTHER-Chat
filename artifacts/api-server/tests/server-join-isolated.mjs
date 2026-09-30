// Fase 0.1: nadie entra a un servidor sin una invitación válida.
// Antes, POST /servers/:serverId/join insertaba al usuario en cualquier
// servidor existente; los identificadores son consecutivos y se recorrían.
import assert from "node:assert/strict";
import { expectStatus, registerAdminAndMembers, startIsolatedApi } from "./helpers/isolated-api.mjs";

const api = await startIsolatedApi("server_join");
try {
  const { base, sql } = api;
  const { admin, members: [outsider, invited] } = await registerAdminAndMembers(base, "join", 2);

  // Servidores de relleno para que ningún id de servidor coincida con el de un usuario.
  for (let index = 0; index < 4; index += 1) {
    expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: `Relleno ${index}` } }), 201, "create filler server");
  }
  const target = expectStatus(await admin.request("/api/servers", {
    method: "POST", json: { name: "Privado" },
  }), 201, "create the private server");
  assert.notEqual(target.id, outsider.user.id, "server id must differ from the outsider id");
  assert.notEqual(target.id, invited.user.id, "server id must differ from the invited member id");

  const membership = userId => sql(
    `SELECT count(*) FROM server_members WHERE server_id = ${target.id} AND user_id = ${userId}`,
  )[0];
  assert.equal(membership(outsider.user.id), "0", "the outsider starts outside the private server");

  // 1. Un no miembro, no administrador, no puede entrar por id.
  {
    const response = await outsider.client.request(`/api/servers/${target.id}/join`, { method: "POST" });
    assert.equal(response.status, 404, `joining by id must not exist, got ${response.status}`);
    assert.equal(membership(outsider.user.id), "0", "no server_members row is created by joining by id");
    console.log("PASS a non-member cannot join a server by id (404, no membership row)");
  }

  // 2. Tampoco el servidor aparece en su lista.
  {
    const servers = expectStatus(await outsider.client.request("/api/servers"), 200, "list outsider servers");
    assert.ok(!servers.some(server => server.id === target.id), "the private server is not listed for the outsider");
    console.log("PASS the private server is not listed for the outsider");
  }

  // 3. Con una invitación del servidor sí se entra.
  {
    const invite = expectStatus(await admin.request(`/api/servers/${target.id}/invites`, {
      method: "POST", json: {},
    }), 201, "create a server invite");
    const joined = expectStatus(await invited.client.request("/api/servers/join-by-invite", {
      method: "POST", json: { code: invite.code },
    }), 200, "join with a valid invite");
    assert.equal(joined.id, target.id);
    assert.equal(membership(invited.user.id), "1", "a valid invite creates exactly one membership row");
    console.log("PASS a valid server invite still joins the server");
  }

  // 4. Una invitación revocada no sirve.
  {
    const invite = expectStatus(await admin.request(`/api/servers/${target.id}/invites`, {
      method: "POST", json: {},
    }), 201, "create a second server invite");
    expectStatus(await admin.request(`/api/servers/${target.id}/invites/${invite.code}`, { method: "DELETE" }), 204, "revoke the invite");
    const response = await outsider.client.request("/api/servers/join-by-invite", {
      method: "POST", json: { code: invite.code },
    });
    assert.equal(response.status, 404, `a revoked invite must be rejected, got ${response.status}`);
    assert.equal(membership(outsider.user.id), "0", "a revoked invite creates no membership row");
    console.log("PASS a revoked invite does not join the server");
  }

  console.log("PASS all server join checks passed");
} finally {
  await api.stop();
}
