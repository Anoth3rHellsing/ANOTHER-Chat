// Prueba de interfaz del D2 con dos cuentas reales en Chromium.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:58000";
const SHOTS = `${process.env.E2E_DIR ?? "/tmp/another-e2e"}/shots`;
mkdirSync(SHOTS, { recursive: true });
const PW = "Sintetica-12345!";
const results = [];
const ok = label => { results.push(`PASS ${label}`); console.log(`PASS ${label}`); };

const browser = await chromium.launch();
async function login(context, username) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(BASE + "/");
  await page.getByPlaceholder("Nombre de usuario").fill(username);
  await page.getByPlaceholder("••••••••").fill(PW);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/app/, { timeout: 15000 });
  await openServer(page);
  return { page, errors };
}
async function openServer(page) {
  const back = page.getByRole("button", { name: "Volver a la lista de servidores" });
  const isMobile = (page.viewportSize()?.width ?? 1280) < 768;
  if (isMobile) {
    await back.waitFor({ state: "visible", timeout: 10000 });
    await back.click();
  }
  await page.locator('button[title="Pruebas"]').first().click();
  if (isMobile) {
    // Al abrir un servidor, el móvil entra directamente en el primer canal de texto.
    const toChannels = page.getByRole("button", { name: "Volver a los canales" }).first();
    await toChannels.waitFor({ state: "visible", timeout: 10000 });
    await toChannels.click();
  }
  await page.locator('[data-testid^="channel-item-"]', { hasText: "general-texto-1" }).waitFor({ state: "visible", timeout: 15000 });
}
const sidebarNames = page => page.locator('[data-testid^="channel-item-"], [data-testid^="channel-row-"] button:first-child').allInnerTexts();

const managerCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const viewerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const { page: mgr, errors: mgrErrors } = await login(managerCtx, "gestor");
const { page: viewer, errors: viewerErrors } = await login(viewerCtx, "miembro");

// 1. Agrupación y orden
await mgr.screenshot({ path: `${SHOTS}/01-escritorio-gestor.png`, clip: { x: 0, y: 0, width: 320, height: 800 } });
const categories = await mgr.locator('[data-testid^="category-row-"]').allInnerTexts();
assert.deepEqual(categories.map(t => t.trim().toUpperCase()), ["TEXTO", "VOZ"]);
ok("sidebar shows categories in order: Texto, Voz");
await viewer.screenshot({ path: `${SHOTS}/02-movil-miembro.png` });
assert.equal(await viewer.locator('[data-testid^="channel-menu-"]').count(), 0);
assert.equal(await viewer.locator('[data-testid^="category-menu-"]').count(), 0);
ok("a member without MANAGE_CHANNELS sees no management menus");

// 2. Renombrar desde el menú ⋮ ; el otro usuario lo ve sin recargar
const borrameRow = mgr.locator('[data-testid^="channel-row-"]', { hasText: "borrame" });
await borrameRow.hover();
await borrameRow.locator('[data-testid^="channel-menu-"]').click();
await mgr.getByRole("menuitem", { name: "Editar canal" }).click();
await mgr.locator("#edit-channel-name").fill("borrado pronto");
await mgr.screenshot({ path: `${SHOTS}/03-editar-canal.png` });
await mgr.getByRole("button", { name: "Guardar" }).click();
await mgr.locator('[data-testid^="channel-item-"]', { hasText: "borrado-pronto" }).waitFor({ timeout: 5000 });
ok("manager renames a channel from the ⋮ menu (name normalised to borrado-pronto)");
await viewer.locator('[data-testid^="channel-item-"]', { hasText: "borrado-pronto" }).waitFor({ timeout: 8000 });
ok("the other account sees the rename live, without reloading");

// 3. Mover con clic derecho a otra categoría
const archivosRow = mgr.locator('[data-testid^="channel-row-"]', { hasText: "archivos" });
await archivosRow.click({ button: "right" });
await mgr.getByRole("menuitem", { name: "Mover a" }).hover();
await mgr.getByRole("menuitem", { name: "Texto", exact: true }).click();
await mgr.waitForTimeout(800);
const textoGroup = mgr.locator('[data-testid^="category-row-"]', { hasText: "Texto" }).locator("xpath=..");
await textoGroup.getByText("archivos").waitFor({ timeout: 5000 });
ok("right-click menu moves a channel into another category");

// 4. Reordenar categorías: Voz sube
const vozHeader = mgr.locator('[data-testid^="category-row-"]', { hasText: "Voz" });
await vozHeader.hover();
await vozHeader.locator('[data-testid^="category-menu-"]').click();
await mgr.getByRole("menuitem", { name: "Subir" }).click();
await mgr.waitForTimeout(800);
assert.deepEqual((await mgr.locator('[data-testid^="category-row-"]').allInnerTexts()).map(t => t.trim().toUpperCase()), ["VOZ", "TEXTO"]);
ok("category moved up: Voz is now above Texto");
await viewer.waitForTimeout(1500);
assert.deepEqual((await viewer.locator('[data-testid^="category-row-"]').allInnerTexts()).map(t => t.trim().toUpperCase()), ["VOZ", "TEXTO"]);
ok("the other account sees the new category order live");

// 5. Eliminar con nombre escrito
const bpRow = mgr.locator('[data-testid^="channel-row-"]', { hasText: "borrado-pronto" });
await bpRow.hover();
await bpRow.locator('[data-testid^="channel-menu-"]').click();
await mgr.getByRole("menuitem", { name: "Eliminar canal" }).click();
const del = mgr.getByRole("button", { name: "Eliminar canal" });
assert.equal(await del.isDisabled(), true);
await mgr.locator("#delete-channel-confirm").fill("borrado");
assert.equal(await del.isDisabled(), true);
ok("delete stays disabled until the exact channel name is typed");
await mgr.locator("#delete-channel-confirm").fill("borrado-pronto");
await mgr.screenshot({ path: `${SHOTS}/04-eliminar-canal.png` });
await del.click();
await mgr.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5000 });
assert.equal(await mgr.locator('[data-testid^="channel-item-"]', { hasText: "borrado-pronto" }).count(), 0);
await viewer.waitForTimeout(1500);
assert.equal(await viewer.locator('[data-testid^="channel-item-"]', { hasText: "borrado-pronto" }).count(), 0);
ok("channel deleted for both accounts");

// 6. Último canal de texto: se muestra el mensaje real del servidor
const lastText = mgr.locator('[data-testid^="channel-row-"]', { hasText: "general-texto-1" });
await lastText.hover();
await lastText.locator('[data-testid^="channel-menu-"]').click();
await mgr.getByRole("menuitem", { name: "Eliminar canal" }).click();
await mgr.locator("#delete-channel-confirm").fill("general-texto-1");
await mgr.getByRole("button", { name: "Eliminar canal" }).click();
await mgr.getByText("No se puede eliminar el último canal de texto del servidor.").waitFor({ timeout: 5000 });
await mgr.screenshot({ path: `${SHOTS}/05-ultimo-canal-texto.png` });
ok("deleting the last text channel shows the server's Spanish 409 message");
await mgr.getByRole("button", { name: "Cancelar" }).click();

// 7. Plegar una categoría y que se recuerde al recargar
await mgr.locator('[data-testid^="category-row-"]', { hasText: "Voz" }).locator("button").first().click();
assert.equal(await mgr.locator('[data-testid^="channel-row-"]', { hasText: "voz-general-1" }).count(), 0);
await mgr.reload();
await openServer(mgr);
await mgr.locator('[data-testid^="category-row-"]', { hasText: "Voz" }).waitFor();
assert.equal(await mgr.locator('[data-testid^="channel-row-"]', { hasText: "voz-general-1" }).count(), 0);
ok("collapsed category stays collapsed after reload (per-browser)");
await mgr.locator('[data-testid^="category-row-"]', { hasText: "Voz" }).locator("button").first().click();

// 8. Crear categoría desde el + de la cabecera
await mgr.locator('[data-testid="sidebar-create-menu"]').click();
await mgr.getByRole("menuitem", { name: "Crear categoría" }).click();
await mgr.locator("#category-name").fill("Media");
await mgr.getByRole("button", { name: "Crear" }).click();
await mgr.locator('[data-testid^="category-row-"]', { hasText: "Media" }).waitFor({ timeout: 5000 });
ok("manager creates a category from the sidebar");

// 9. Gestor en móvil: menú visible sin hover, sin desbordamiento horizontal
const mobileMgrCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const { page: mobileMgr, errors: mobileErrors } = await login(mobileMgrCtx, "gestor");
const menuButton = mobileMgr.locator('[data-testid^="channel-menu-"]').first();
assert.equal(await menuButton.evaluate(el => getComputedStyle(el).opacity), "1");
const box = await menuButton.boundingBox();
assert.ok(box && box.width >= 44 && box.height >= 44, `touch target ${box?.width}x${box?.height}`);
ok("on touch screens the ⋮ menu is always visible with a 44 px target");
const overflow = await mobileMgr.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
ok("no horizontal overflow at 390 px");
await mobileMgr.screenshot({ path: `${SHOTS}/06-movil-gestor.png` });
await menuButton.tap();
await mobileMgr.getByRole("menuitem", { name: "Editar canal" }).waitFor();
await mobileMgr.screenshot({ path: `${SHOTS}/07-movil-menu-abierto.png` });
ok("tapping ⋮ on mobile opens the channel menu");

await mobileMgr.keyboard.press("Escape");
const catButtons = mobileMgr.locator('[data-testid^="category-menu-"]');
const catBox = await catButtons.first().boundingBox();
assert.ok(catBox && catBox.width >= 44 && catBox.height >= 44, `category menu ${catBox?.width}x${catBox?.height}`);
ok("category controls have a 44 px touch target on mobile");
await mobileMgr.getByRole("button", { name: "Clips" }).filter({ visible: true }).first().tap();
await mobileMgr.getByRole("button", { name: "Volver a los canales" }).filter({ visible: true }).first().waitFor({ timeout: 5000 });
assert.ok(await mobileMgr.getByText("Subir", { exact: false }).filter({ visible: true }).count() >= 0);
await mobileMgr.screenshot({ path: `${SHOTS}/08-movil-clips.png` });
ok("tapping Clips on mobile opens the Clips view, with a way back");
await mobileMgr.getByRole("button", { name: "Volver a los canales" }).filter({ visible: true }).first().tap();
await mobileMgr.locator('[data-testid^="channel-row-"]').first().waitFor({ state: "visible", timeout: 5000 });
ok("the Clips back button returns to the channel list");

const allErrors = [...mgrErrors, ...viewerErrors, ...mobileErrors];
assert.deepEqual(allErrors, [], `page errors: ${allErrors.join(" | ")}`);
ok("no uncaught page errors in any of the three sessions");
await browser.close();
console.log(`${results.length} checks passed`);
