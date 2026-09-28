// Auditoría móvil: recorre la app a 390x844 táctil, hace capturas y mide problemas objetivos.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import fs from "node:fs";
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:58000";
const OUT = `${process.env.E2E_DIR ?? "/tmp/another-e2e"}/audit`, PW = "Sintetica-12345!";
mkdirSync(OUT, { recursive: true });
const report = [];
let n = 0;
const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ["microphone", "camera"] });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));

async function measure() {
  return page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const label = el => (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.getAttribute("placeholder") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
    const inter = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role="button"], [role="menuitem"], [role="tab"]')].filter(visible);
    const offscreen = inter.filter(el => { const r = el.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).map(label);
    const tiny = inter.filter(el => { const r = el.getBoundingClientRect(); return (r.width < 32 || r.height < 32) && !["INPUT","TEXTAREA","SELECT"].includes(el.tagName) && !(el.type === "checkbox" || el.type === "radio" || el.type === "range"); }).map(el => { const r = el.getBoundingClientRect(); return `${label(el)} (${Math.round(r.width)}x${Math.round(r.height)})`; });
    return { overflowX: document.scrollingElement.scrollWidth - vw, offscreen: [...new Set(offscreen)].slice(0, 10), tiny: [...new Set(tiny)].slice(0, 14), tinyCount: tiny.length };
  });
}
async function step(name, fn) {
  n += 1; const id = String(n).padStart(2, "0");
  let error = null;
  try { await fn(); await page.waitForTimeout(700); } catch (e) { error = e.message.split("\n")[0].slice(0, 200); }
  await page.screenshot({ path: `${OUT}/${id}-${name}.png` }).catch(() => {});
  const m = await measure().catch(e => ({ error: e.message }));
  const entry = { id, name, error, ...m };
  report.push(entry);
  console.log(`${id} ${name}${error ? "  ✖ " + error : ""}  overflowX=${m.overflowX} offscreen=${m.offscreen?.length} tiny=${m.tinyCount}`);
  if (error) await page.keyboard.press("Escape").catch(() => {});
}
const byName = (name, exact = false) => page.getByRole("button", { name, exact }).filter({ visible: true }).first();
const tap = async locator => { await locator.waitFor({ state: "visible", timeout: 6000 }); await locator.tap(); };
async function fresh() { await page.goto(BASE + "/app"); await page.waitForTimeout(1800); }
async function closeAll() {
  await page.keyboard.press("Escape").catch(() => {});
  for (const name of ["Cerrar", "Cerrar panel", "Cerrar miembros", "Cerrar selector de GIF"]) {
    const b = page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
    if (await b.isVisible().catch(() => false)) await b.tap().catch(() => {});
  }
  const backdrop = page.locator("div.fixed.inset-0").filter({ visible: true }).last();
  if (await backdrop.isVisible().catch(() => false)) await backdrop.click({ position: { x: 4, y: 4 } }).catch(() => {});
}
async function toRail() { const b = byName("Volver a la lista de servidores"); if (await b.isVisible().catch(() => false)) await b.tap(); }
async function toChannels() { const b = byName("Volver a los canales"); if (await b.isVisible().catch(() => false)) await b.tap(); }
async function openServer() { await toChannels(); await toRail(); await tap(page.locator('button[title="Pruebas"]').first()); await page.waitForTimeout(800); await toChannels(); }
async function openChannel(name) { await openServer(); await tap(page.locator('[data-testid^="channel-row-"], [data-testid^="channel-item-"]').filter({ hasText: name }).first().locator("button").first().or(page.locator('[data-testid^="channel-item-"]').filter({ hasText: name }).first())); }

// Login
await page.goto(BASE + "/");
await step("login", async () => {});
await page.getByPlaceholder("Nombre de usuario").fill("dueno");
await page.getByPlaceholder("••••••••").fill(PW);
await page.locator('button[type="submit"]').tap();
await page.waitForURL(/\/app/);
await page.waitForTimeout(1500);

await step("inicio-tras-login", async () => {});
await step("rail-servidores", async () => { await toChannels(); await toRail(); });
await step("lista-canales", async () => { await openServer(); });
await step("chat-texto", async () => { await openChannel("general-texto-1"); });
await step("acciones-mensaje", async () => { await tap(page.getByRole("button", { name: "Más acciones del mensaje" }).filter({ visible: true }).nth(1)); });
await step("tocar-fuera-de-acciones", async () => { await page.getByText("¿Quién se conecta").tap(); });
await step("selector-emoji", async () => { await fresh(); await openChannel("general-texto-1"); await tap(byName("Insertar emoji")); });
await step("selector-gif", async () => { await fresh(); await openChannel("general-texto-1"); await tap(byName("Buscar GIF")); });
await step("miembros", async () => { await fresh(); await openChannel("general-texto-1"); await tap(byName("Miembros")); });
await step("buscar-mensajes", async () => { await fresh(); await openChannel("general-texto-1"); await tap(byName("Buscar mensajes")); });
await step("eventos-del-canal", async () => { await fresh(); await openChannel("general-texto-1"); await tap(page.getByRole("button", { name: /Eventos/ }).filter({ visible: true }).first()); });
await step("canal-calendario", async () => { await fresh(); await openChannel("eventos-de-atornillados"); });
await step("canal-archivos", async () => { await fresh(); await openChannel("archivos"); });
await step("clips", async () => { await fresh(); await openServer(); await tap(page.getByRole("button", { name: "Clips" }).filter({ visible: true }).first()); });
await step("entrar-voz", async () => { await fresh(); await openServer(); await tap(page.getByRole("button", { name: /voz-general-1/ }).filter({ visible: true }).first()); await page.waitForTimeout(3000); });
await step("llamada-expandida", async () => { const e = byName("Expandir llamada"); if (await e.isVisible().catch(() => false)) await e.tap(); });
await step("soundboard", async () => { await tap(page.getByRole("button", { name: /soundboard/i }).filter({ visible: true }).first()); });
await step("watch-party", async () => { await closeAll(); await tap(page.getByRole("button", { name: /Ver y escuchar juntos|Visionado y escucha/ }).filter({ visible: true }).first()); });
await step("controles-participantes", async () => { await closeAll(); await tap(page.getByRole("button", { name: /Controlar voz|Ajustar voz|Controles de participantes/ }).filter({ visible: true }).first()); });
await step("minimizar-llamada", async () => { await closeAll(); await tap(byName("Minimizar llamada")); });
await step("llamada-minimizada-en-chat", async () => { await openChannel("general-texto-1"); });
await step("lista-canales-en-llamada", async () => { await toChannels(); });
await step("colgar", async () => { await tap(page.getByRole("button", { name: /^Colgar/ }).filter({ visible: true }).first()); });
await step("mensajes-directos", async () => { await fresh(); await toChannels(); await toRail(); await tap(page.locator('button[title="Mensajes directos"]').first()); });
await step("conversacion-md", async () => { await tap(page.getByText("Miembro").filter({ visible: true }).first()); });
await step("amigos", async () => { await fresh(); await toChannels(); await toRail(); await tap(page.locator('button[title="Mensajes directos"]').first()); await tap(page.locator('[title="Amigos"]').filter({ visible: true }).first()); });
await step("nuevo-grupo", async () => { await fresh(); await toChannels(); await toRail(); await tap(page.locator('button[title="Mensajes directos"]').first()); await tap(page.locator('[title="Nuevo grupo"]').filter({ visible: true }).first()); });
await step("perfil", async () => { await fresh(); await openServer(); await tap(page.locator('button[title="Perfil"]').filter({ visible: true }).first()); });
await step("ajustes", async () => { await fresh(); await openServer(); await tap(page.locator('[title="Ajustes"]').filter({ visible: true }).first()); });
await step("config-servidor", async () => { await fresh(); await openServer(); await tap(byName("Configuración del servidor")); });
await step("anadir-servidor", async () => { await fresh(); await toChannels(); await toRail(); await tap(page.locator('button[title="Añadir Servidor"]').first()); });
await step("unirse-con-codigo", async () => { await fresh(); await toChannels(); await toRail(); await tap(page.locator('button[title="Unirse con código"]').first()); });
await step("panel-admin", async () => { await fresh(); await toChannels(); await toRail(); await tap(page.locator('[title="Panel de Admin"]').filter({ visible: true }).first()); });
await step("historias", async () => { await fresh(); await openServer(); await tap(page.getByText("Tú").filter({ visible: true }).first()); });
await step("notificaciones", async () => { await fresh(); await openChannel("general-texto-1"); await tap(page.locator('[title="Abrir ajustes de notificaciones"]').filter({ visible: true }).first()); });

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ report, pageErrors }, null, 2));
console.log("pageErrors:", pageErrors.length, pageErrors.slice(0, 5));
await browser.close();
