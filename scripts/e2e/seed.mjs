// Datos sintéticos para la prueba en navegador.
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:58000";
function account() {
  const cookies = new Map();
  return {
    async req(url, { method = "GET", json } = {}) {
      const headers = {};
      if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      if (cookies.has("csrf_token") && method !== "GET") headers["x-csrf-token"] = cookies.get("csrf_token");
      if (json !== undefined) headers["Content-Type"] = "application/json";
      const r = await fetch(BASE + url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
      for (const c of r.headers.getSetCookie()) { const p = c.split(";")[0]; const i = p.indexOf("="); cookies.set(p.slice(0, i), p.slice(i + 1)); }
      const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
      if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${text}`);
      return body;
    },
  };
}
const PW = "Sintetica-12345!";
const owner = account(), manager = account(), viewer = account();
await owner.req("/api/auth/register", { method: "POST", json: { username: "dueno", password: PW, displayName: "Dueño" } });
await owner.req("/api/auth/login", { method: "POST", json: { username: "dueno", password: PW } });
for (const [acc, u, d] of [[manager, "gestor", "Gestor"], [viewer, "miembro", "Miembro"]]) {
  const inv = await owner.req("/api/admin/invites", { method: "POST", json: {} });
  await acc.req("/api/auth/register", { method: "POST", json: { username: u, password: PW, displayName: d, inviteCode: inv.code } });
  await acc.req("/api/auth/login", { method: "POST", json: { username: u, password: PW } });
}
const server = await owner.req("/api/servers", { method: "POST", json: { name: "Pruebas" } });
const sid = server.id;
const mk = (name, channelType = "text", categoryId) => owner.req(`/api/servers/${sid}/channels`, { method: "POST", json: { name, channelType, ...(categoryId ? { categoryId } : {}) } });
const catText = await owner.req(`/api/servers/${sid}/categories`, { method: "POST", json: { name: "Texto" } });
const catVoice = await owner.req(`/api/servers/${sid}/categories`, { method: "POST", json: { name: "Voz" } });
await mk("general-texto-1", "text", catText.id);
await mk("eventos-de-atornillados", "calendar", catText.id);
await mk("voz-general-1", "voice", catVoice.id);
await mk("voice-2", "voice", catVoice.id);
await mk("archivos", "media");
await mk("borrame", "text");
for (const acc of [manager, viewer]) {
  const inv = await owner.req(`/api/servers/${sid}/invites`, { method: "POST", json: {} });
  await acc.req("/api/servers/join-by-invite", { method: "POST", json: { code: inv.code } });
}
const role = await owner.req(`/api/servers/${sid}/roles`, { method: "POST", json: { name: "Gestores", permissions: 1 } });
const me = await manager.req("/api/auth/me");
await owner.req(`/api/servers/${sid}/members/${me.id}/roles/${role.id}`, { method: "POST", json: {} });
console.log(JSON.stringify({ sid, managerId: me.id, managerRole: me.role, catText: catText.id, catVoice: catVoice.id }));

// ── Datos extra para la auditoría móvil ──
const chans = await owner.req(`/api/servers/${sid}/channels`);
const general = chans.find(c => c.name === "general-texto-1");
const cal = chans.find(c => c.name === "eventos-de-atornillados");
const lines = [
  "Hola a todos 👋",
  "Mensaje largo para ver cómo se parte en el móvil: " + "palabra ".repeat(40),
  "Un enlace larguísimo sin espacios https://example.com/" + "a".repeat(120),
  "¿Quién se conecta esta noche a la llamada?",
];
for (const content of lines) await owner.req(`/api/channels/${general.id}/messages`, { method: "POST", json: { content } });
await viewer.req(`/api/channels/${general.id}/messages`, { method: "POST", json: { content: "Yo me conecto a las 9 🎮" } });
const ownerMe = await owner.req("/api/auth/me");
await viewer.req(`/api/dms/${ownerMe.id}`, { method: "POST", json: { content: "Hola, ¿me pasas el enlace de la tienda?" } });
await owner.req(`/api/channels/${cal.id}/events`, { method: "POST", json: { title: "Noche de juegos", description: "Traigan snacks", startsAt: new Date(Date.now() + 3 * 864e5).toISOString(), originalTimeZone: "America/Bogota" } });
console.log("extra seed ok");
