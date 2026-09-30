// Baneo global en el navegador: el baneado sale al instante a la pantalla de acceso con el aviso.
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
const member = await signIn(await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }), "miembro");

const status = await owner.page.evaluate(async () => {
  const csrf = document.cookie.split("; ").find(pair => pair.startsWith("csrf_token="))?.split("=")[1];
  const users = await (await fetch("/api/admin/users")).json();
  const target = users.find(user => user.username === "miembro");
  const response = await fetch(`/api/admin/users/${target.id}/ban`, { method: "POST", headers: { "x-csrf-token": csrf } });
  return response.status;
});
assert.equal(status, 204, "the owner bans the member");

await member.page.waitForURL(url => url.pathname === "/" && url.search.includes("cuenta=baneada"), { timeout: 10_000 });
await member.page.getByRole("alert").filter({ hasText: "Tu cuenta ha sido baneada" }).waitFor();
ok("the banned member is sent to the sign-in screen with the notice, without reloading");
await member.page.screenshot({ path: `${SHOTS}/ban-01-aviso-movil.png` });

await member.page.getByPlaceholder("Nombre de usuario").fill("miembro");
await member.page.getByPlaceholder("••••••••").fill("Sintetica-12345!");
await member.page.locator('button[type="submit"]').tap();
await member.page.getByText("Tu cuenta ha sido baneada").nth(1).waitFor();
assert.ok(!member.page.url().includes("/app"), "a banned member cannot sign in again");
ok("signing in again shows the API's own message");

const overflow = await member.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
assert.equal(overflow, false, "no horizontal overflow at 390 px");
assert.deepEqual([...owner.errors, ...member.errors], [], "no JavaScript errors");
ok("no JavaScript errors and no horizontal overflow");
await browser.close();
