// Fase 0.5: la API de eventos responde en español (AGENTS.md §10).
import assert from "node:assert/strict";
import { expectStatus, registerAdminAndMembers, startIsolatedApi } from "./helpers/isolated-api.mjs";

const ENGLISH = /\b(must|not found|cannot|Invalid|You|already|Past|Canceled|provided)\b/;

function expectSpanishError(response, status, pattern, label) {
  assert.equal(response.status, status, `${label}: expected ${status}, got ${response.status}`);
  const message = response.result?.error;
  assert.equal(typeof message, "string", `${label}: error message present`);
  assert.doesNotMatch(message, ENGLISH, `${label}: message is not in English (${message})`);
  assert.match(message, pattern, `${label}: ${message}`);
}

const api = await startIsolatedApi("events_es");
try {
  const { base } = api;
  const { admin, members: [member, outsider] } = await registerAdminAndMembers(base, "events", 2);
  for (let index = 0; index < 4; index += 1) {
    expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: `Relleno ${index}` } }), 201, "filler server");
  }
  const server = expectStatus(await admin.request("/api/servers", { method: "POST", json: { name: "Eventos" } }), 201, "create server");
  assert.notEqual(server.id, member.user.id);
  const invite = expectStatus(await admin.request(`/api/servers/${server.id}/invites`, { method: "POST", json: {} }), 201, "invite");
  expectStatus(await member.client.request("/api/servers/join-by-invite", { method: "POST", json: { code: invite.code } }), 200, "join");
  const channel = expectStatus(await admin.request(`/api/servers/${server.id}/channels`, {
    method: "POST", json: { name: "planes", channelType: "text" },
  }), 201, "create channel");
  assert.notEqual(channel.id, member.user.id);

  const events = `/api/channels/${channel.id}/events`;
  const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

  expectSpanishError(await member.client.request(events, { method: "POST", json: { title: "", startsAt: future } }),
    400, /título/, "empty title");
  expectSpanishError(await member.client.request(events, { method: "POST", json: { title: "Asado", startsAt: "mañana" } }),
    400, /fecha de inicio/, "invalid start");
  expectSpanishError(await member.client.request(events, { method: "POST", json: { title: "Asado", startsAt: future, originalTimeZone: "Marte/Olimpo" } }),
    400, /zona horaria/, "invalid time zone");
  expectSpanishError(await member.client.request(`${events}/999999`), 404, /Evento no encontrado/, "missing event");
  expectSpanishError(await outsider.client.request(events), 403, /No tienes acceso/, "outsider");
  expectSpanishError(await member.client.request("/api/channels/abc/events"), 400, /Identificador de canal/, "invalid channel id");
  console.log("PASS event validation and access errors are in Spanish");

  const created = expectStatus(await member.client.request(events, {
    method: "POST", json: { title: "Asado", startsAt: future, originalTimeZone: "America/Bogota" },
  }), 201, "create a valid event");
  const eventId = created.event?.id ?? created.id;
  assert.ok(Number.isSafeInteger(eventId), "created event id");
  expectSpanishError(await member.client.request(`${events}/${eventId}/response`, { method: "PUT", json: { status: "tal vez" } }),
    400, /sí, no o quizás/, "invalid response");
  expectSpanishError(await member.client.request(`${events}/${eventId}`, { method: "PATCH", json: {} }),
    400, /al menos un campo/, "empty patch");
  expectStatus(await member.client.request(`${events}/${eventId}`, { method: "DELETE" }), 200, "cancel the event");
  expectSpanishError(await member.client.request(`${events}/${eventId}`, { method: "DELETE" }), 409, /ya está cancelado/, "cancel twice");
  expectSpanishError(await member.client.request(`${events}/${eventId}`, { method: "PATCH", json: { title: "Otro" } }),
    409, /cancelado no se puede editar/, "edit canceled");
  console.log("PASS event state errors are in Spanish");

  console.log("PASS all event Spanish error checks passed");
} finally {
  await api.stop();
}
