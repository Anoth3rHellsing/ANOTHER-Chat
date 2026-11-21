// Vistas previas de adjuntos: cada referencia blob: se libera al quitar, enviar o salir,
// sin romper las miniaturas que siguen en pantalla. Escritorio (1280) y móvil táctil (390).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:58000";
const SHOTS = `${process.env.E2E_DIR ?? "/tmp/another-e2e"}/shots`;
mkdirSync(SHOTS, { recursive: true });
const results = []; const ok = l => { results.push(l); console.log("PASS " + l); };

// PNG 1×1 válido; cada archivo lleva un nombre distinto.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PENDING = 'img[alt^="previa-"][src^="blob:"]';
const png = name => ({ name, mimeType: "image/png", buffer: PNG });

// Cuenta las referencias vivas sin cambiar su comportamiento.
const trackBlobs = () => {
  const live = new Set(); let created = 0;
  const create = URL.createObjectURL.bind(URL); const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = obj => { const u = create(obj); live.add(u); created++; return u; };
  URL.revokeObjectURL = u => { live.delete(u); revoke(u); };
  window.__blobs = () => ({ live: [...live], created });
};

const browser = await chromium.launch();
for (const mode of ["escritorio", "movil"]) {
  const mobile = mode === "movil";
  const ctx = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(trackBlobs);
  const page = await ctx.newPage(); const errors = []; page.on("pageerror", e => errors.push(e.message));
  const press = loc => mobile ? loc.tap() : loc.click();
  const vis = name => page.getByRole("button", { name }).filter({ visible: true }).first();
  const blobs = () => page.evaluate(() => window.__blobs());
  // Solo las miniaturas del compositor (blob:), no las imágenes ya enviadas con el mismo nombre.
  const previews = () => page.locator(PENDING);
  // Cada miniatura en pantalla apunta a una referencia viva y la imagen se decodificó.
  const assertPreviewsLive = async expected => {
    await page.waitForFunction(([sel, n]) => [...document.querySelectorAll(sel)].filter(i => i.complete && i.naturalWidth > 0).length === n, [PENDING, expected]);
    const srcs = await previews().evaluateAll(els => els.map(e => e.getAttribute("src")));
    const { live } = await blobs();
    assert.equal(srcs.length, expected);
    for (const s of srcs) assert.ok(live.includes(s), `preview ${s} was revoked while still shown`);
    return srcs;
  };

  await page.goto(BASE + "/");
  await page.getByPlaceholder("Nombre de usuario").fill("dueno"); await page.getByPlaceholder("••••••••").fill("Sintetica-12345!");
  await press(page.locator('button[type="submit"]')); await page.waitForURL(/\/app/); await page.waitForTimeout(1500);
  async function openGeneral() {
    if (await vis("Volver a los canales").isVisible().catch(() => false)) await press(vis("Volver a los canales"));
    if (await vis("Volver a la lista de servidores").isVisible().catch(() => false)) await press(vis("Volver a la lista de servidores"));
    await press(page.locator('button[title="Pruebas"]').first()); await page.waitForTimeout(800);
    if (await vis("Volver a los canales").isVisible().catch(() => false)) await press(vis("Volver a los canales"));
    await press(page.locator('[data-testid^="channel-item-"]').filter({ hasText: "general-texto-1" }));
    await page.getByText("Hola a todos").waitFor();
  }
  await openGeneral();
  const input = page.getByPlaceholder("Escribir en #general-texto-1...");
  const fileInput = page.getByTestId("channel-file-input");

  // 1. Dos imágenes: dos referencias, ni una más.
  let uploads = 0;
  const uploaded = new Promise(resolve => page.on("response", r => {
    if (/\/api\/channels\/\d+\/attachments$/.test(r.url()) && r.request().method() === "POST" && r.ok() && ++uploads === 2) resolve();
  }));
  await fileInput.setInputFiles([png(`previa-a-${mode}.png`), png(`previa-b-${mode}.png`)]);
  await assertPreviewsLive(2);
  await uploaded;
  assert.equal((await blobs()).live.length, 2);
  ok(`${mode}: two image previews hold exactly two live blob URLs`);

  // 2. Escribir vuelve a renderizar el compositor: no puede crear referencias nuevas.
  const before = (await blobs()).created;
  await input.fill(""); await input.pressSequentially("renderizando sin fugas", { delay: 10 });
  const [, srcB] = await assertPreviewsLive(2);
  assert.equal((await blobs()).created, before, "typing created new blob URLs");
  assert.equal((await blobs()).live.length, 2);
  ok(`${mode}: re-rendering while typing creates no new blob URLs`);
  await page.screenshot({ path: `${SHOTS}/previews-${mode}-01-dos.png` });

  // 3. Quitar una: su referencia se libera y la otra sigue mostrándose.
  await press(page.getByRole("button", { name: `Quitar previa-a-${mode}.png` }));
  const [left] = await assertPreviewsLive(1);
  assert.equal((await blobs()).live.length, 1);
  assert.equal(await previews().getAttribute("alt"), `previa-b-${mode}.png`);
  assert.equal(left, srcB, "the remaining preview must keep its own URL, not be re-created");
  ok(`${mode}: removing a preview revokes its URL and keeps the other one displayed`);

  // 4. Salir de la vista del canal desmonta la miniatura y libera la referencia.
  for (const back of ["Volver a los canales", "Volver a la lista de servidores"])
    if (await vis(back).isVisible().catch(() => false)) await press(vis(back));
  await press(page.locator('button[title="Mensajes directos"]').filter({ visible: true }).first());
  await page.waitForFunction(sel => !document.querySelector(sel), PENDING);
  assert.equal((await blobs()).live.length, 0, "leaving the channel view kept blob URLs alive");
  ok(`${mode}: leaving the channel view revokes the preview URL`);
  await openGeneral();
  await assertPreviewsLive(1);
  ok(`${mode}: coming back shows the pending preview again`);

  // 5. Enviar: el mensaje sale con el adjunto y no queda ninguna referencia.
  await input.press("Enter");
  await page.waitForFunction(sel => !document.querySelector(sel), PENDING);
  await page.getByText("renderizando sin fugas").last().waitFor();
  assert.equal((await blobs()).live.length, 0, "sending kept blob URLs alive");
  ok(`${mode}: sending the message revokes every preview URL`);
  await page.screenshot({ path: `${SHOTS}/previews-${mode}-02-enviado.png` });

  assert.ok((await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth)) <= 0);
  ok(`${mode}: no horizontal overflow`);
  assert.deepEqual(errors, []); ok(`${mode}: no page errors`);
  await ctx.close();
}
await browser.close(); console.log(`${results.length} checks passed`);
