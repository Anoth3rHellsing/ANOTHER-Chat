// Filtros de palabras en el móvil: el mensaje bloqueado muestra el motivo real y el texto no se pierde.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:58000";
const SHOTS = `${process.env.E2E_DIR ?? "/tmp/another-e2e"}/shots`;
mkdirSync(SHOTS, { recursive: true });
const ok = label => console.log("PASS " + label);
const browser = await chromium.launch();

async function signIn(context, username) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(BASE + "/");
  await page.getByPlaceholder("Nombre de usuario").fill(username);
  await page.getByPlaceholder("••••••••").fill("Sintetica-12345!");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/app/);
  await page.waitForTimeout(1500);
  return { page, errors };
}

const owner = await signIn(await browser.newContext({ viewport: { width: 1280, height: 800 } }), "dueno");
const status = await owner.page.evaluate(async () => {
  const csrf = document.cookie.split("; ").find(pair => pair.startsWith("csrf_token="))?.split("=")[1];
  const servers = await (await fetch("/api/servers")).json();
  const server = servers.find(item => item.name === "Pruebas");
  const response = await fetch(`/api/servers/${server.id}/word-filters`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ word: "palabrota" }),
  });
  return response.status;
});
assert.equal(status, 201, "the owner adds a word filter");

const { page, errors } = await signIn(await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), "miembro");
const vis = name => page.getByRole("button", { name }).filter({ visible: true }).first();
if (await vis("Volver a los canales").isVisible().catch(() => false)) await vis("Volver a los canales").tap();
if (await vis("Volver a la lista de servidores").isVisible().catch(() => false)) await vis("Volver a la lista de servidores").tap();
await page.locator('button[title="Pruebas"]').first().tap();
await page.waitForTimeout(800);
if (await vis("Volver a los canales").isVisible().catch(() => false)) await vis("Volver a los canales").tap();
await page.locator('[data-testid^="channel-item-"]').filter({ hasText: "general-texto-1" }).tap();
await page.getByText("Hola a todos").waitFor();

const input = page.locator("form input[type='text'], form textarea").filter({ visible: true }).last();
await input.fill("esto es una PALABROTA");
await input.press("Enter");
await page.getByText("No se pudo enviar el mensaje").waitFor({ timeout: 5000 });
await page.getByText(/no permitida en este servidor: «palabrota»/).waitFor();
ok("a blocked message shows the API's own reason in a toast");
assert.equal(await input.inputValue(), "esto es una PALABROTA", "the typed text is kept so it can be edited");
assert.equal(await page.getByText("esto es una PALABROTA").filter({ visible: true }).count(), 0, "the blocked message does not appear in the chat");
ok("the typed text is kept and nothing is added to the chat");
await page.screenshot({ path: `${SHOTS}/filters-01-bloqueado-movil.png` });

await input.fill("esto es una palabra normal");
await input.press("Enter");
await page.getByText("esto es una palabra normal").filter({ visible: true }).first().waitFor();
ok("a clean message is sent normally");

const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
assert.equal(overflow, false, "no horizontal overflow at 390 px");
assert.deepEqual([...owner.errors, ...errors], [], "no JavaScript errors");
ok("no JavaScript errors and no horizontal overflow");
await browser.close();
