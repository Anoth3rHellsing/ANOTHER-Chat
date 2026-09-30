// Fase 0.4: los filtros de palabras del servidor se aplican al escribir y al editar.
// Antes existía el CRUD (Configuración → Filtros) pero ninguna ruta de
// mensajes los consultaba.
import assert from "node:assert/strict";
import { expectStatus, registerAdminAndMembers, startIsolatedApi } from "./helpers/isolated-api.mjs";

const api = await startIsolatedApi("word_filters");
try {
  const { base, sql } = api;
  const { admin, members: [member] } = await registerAdminAndMembers(base, "filters", 1);
  for (let index = 0; index < 4; index += 1) {
    expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: `Relleno ${index}` } }), 201, "filler server");
  }
  const server = expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: "Filtrado" } }), 201, "create server");
  const otherServer = expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: "Sin filtros" } }), 201, "create other server");
  assert.notEqual(server.id, member.user.id);
  for (const target of [server, otherServer]) {
    const invite = expectStatus(await admin.request(`/api/servers/${target.id}/invites`, { method: "POST", json: {} }), 201, "invite");
    expectStatus(await member.client.request("/api/servers/join-by-invite", { method: "POST", json: { code: invite.code } }), 200, "join");
  }
  const channel = expectStatus(await admin.request(`/api/servers/${server.id}/channels`, {
    method: "POST", json: { name: "charla", channelType: "text" },
  }), 201, "create channel");
  const otherChannel = expectStatus(await admin.request(`/api/servers/${otherServer.id}/channels`, {
    method: "POST", json: { name: "charla", channelType: "text" },
  }), 201, "create other channel");
  assert.notEqual(channel.id, server.id);

  for (const word of ["pendejo", "mala palabra", "las"]) {
    expectStatus(await admin.request(`/api/servers/${server.id}/word-filters`, { method: "POST", json: { word } }), 201, `add filter ${word}`);
  }

  const messages = `/api/channels/${channel.id}/messages`;
  const stored = () => Number(sql(`SELECT count(*) FROM messages WHERE channel_id = ${channel.id}`)[0]);
  const post = (client, content, url = messages) => client.request(url, { method: "POST", json: { content } });

  // 1. Palabra filtrada: 400 con el motivo y sin guardar nada.
  {
    const before = stored();
    const response = await post(member.client, "eres un pendejo");
    assert.equal(response.status, 400, `a filtered word must be rejected, got ${response.status}`);
    assert.match(response.result.error, /no permitida.*«pendejo»/);
    assert.equal(stored(), before, "a rejected message is not stored");
    console.log("PASS a message with a filtered word is rejected with 400 and not stored");
  }

  // 2. Sin distinguir mayúsculas ni tildes; también frases.
  {
    assert.equal((await post(member.client, "¡PÉNDEJO!")).status, 400, "case and accents do not bypass the filter");
    assert.equal((await post(member.client, "eso fue una Mala   palabra")).status, 201, "a phrase only matches with its own spacing");
    assert.equal((await post(member.client, "eso fue una mala palabra")).status, 400, "a filtered phrase is rejected");
    console.log("PASS filters ignore case and accents and match phrases");
  }

  // 3. Palabra completa: «clase» no dispara «las».
  {
    expectStatus(await post(member.client, "mañana hay clase y salas llenas"), 201, "words containing a filter are allowed");
    assert.equal((await post(member.client, "las llaves")).status, 400, "the filtered word alone is rejected");
    console.log("PASS filters match whole words only");
  }

  // 4. Editar también se filtra y el mensaje original queda intacto.
  {
    const clean = expectStatus(await post(member.client, "todo tranquilo"), 201, "post a clean message");
    const response = await member.client.request(`${messages}/${clean.id}`, {
      method: "PATCH", json: { content: "todo tranquilo, pendejo" },
    });
    assert.equal(response.status, 400, `editing into a filtered word must be rejected, got ${response.status}`);
    assert.match(response.result.error, /«pendejo»/);
    const history = expectStatus(await member.client.request(messages), 200, "read history");
    const list = Array.isArray(history) ? history : history.messages;
    assert.equal(list.find(message => message.id === clean.id).content, "todo tranquilo", "the original content is kept");
    expectStatus(await member.client.request(`${messages}/${clean.id}`, {
      method: "PATCH", json: { content: "todo tranquilo, amigo" },
    }), 200, "a clean edit is accepted");
    console.log("PASS edits are filtered and a rejected edit keeps the original");
  }

  // 5. Los filtros son de cada servidor.
  {
    expectStatus(await post(member.client, "eres un pendejo", `/api/channels/${otherChannel.id}/messages`), 201, "another server's filters do not apply");
    console.log("PASS filters only apply to their own server");
  }

  // 6. También a los administradores.
  {
    assert.equal((await post(admin, "pendejo")).status, 400, "server admins are filtered too");
    console.log("PASS filters apply to administrators too");
  }

  console.log("PASS all word filter checks passed");
} finally {
  await api.stop();
}
