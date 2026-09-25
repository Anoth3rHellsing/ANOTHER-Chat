#!/usr/bin/env node
'use strict';

// Screenshots of actual app components with browser-only synthetic API responses.
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

(async () => {
  const origin = 'http://127.0.0.1:19327';
  const out = resolve(__dirname, '../../../screenshots/mobile-ui');
  const profile = await mkdtemp(join(tmpdir(), 'mobile-layout-'));
  const browser = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  let seq = 0;
  const pending = new Map();
  let errors = '';
  browser.stderr.on('data', bytes => { errors += bytes.toString(); });
  browser.stdio[4].on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    let end;
    while ((end = buffer.indexOf(0)) !== -1) {
      const message = JSON.parse(buffer.subarray(0, end).toString());
      buffer = buffer.subarray(end + 1);
      if (message.id === undefined) continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 12000);
    pending.set(id, {
      resolve: result => { clearTimeout(timeout); resolve(result); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })}\0`);
  });

  try {
    await mkdir(out, { recursive: true });
    await sleep(800);
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(target => target.type === 'page');
    if (!page) throw new Error(`No browser page: ${errors.slice(-500)}`);
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const command = (method, params) => send(method, params, sessionId);
    const evaluate = async expression => {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 60; i++) {
        if (await evaluate(expression)) return;
        await sleep(200);
      }
      throw new Error(`Not rendered: ${expression}; page: ${(await evaluate('document.body.innerText')).slice(0, 800)}`);
    };
    const size = async width => {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 768 });
    };
    const navigate = async (admin = false) => {
      await command('Page.navigate', { url: `${origin}/tests/mobile-layout-probe.html${admin ? '?admin=1' : ''}` });
      await sleep(900);
    };
    const click = async expression => {
      if (!await evaluate(`(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`)) {
        throw new Error(`No click target: ${expression}`);
      }
      await sleep(350);
    };
    const shot = async name => {
      const overflow = await evaluate('document.documentElement.scrollWidth > window.innerWidth');
      const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(out, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`${name}: viewport overflow=${overflow}`);
    };
    const openChannel = async () => {
      await waitFor("document.body.innerText.includes('Servidor de prueba') || document.body.innerText.includes('Este es un mensaje de prueba')");
      if (await evaluate("document.body.innerText.includes('Este es un mensaje de prueba')")) return;
      await click("document.querySelector('button[title=\"Servidor de prueba\"]')");
      await click("[...document.querySelectorAll('button')].find(b => b.innerText.includes('conversación-general'))");
    };

    await command('Page.enable');
    await command('Runtime.enable');
    await size(390);
    await navigate();
    await openChannel();
    await waitFor("document.body.innerText.includes('Este es un mensaje de prueba')");
    await shot('canal-cerrado-390');
    await click("document.querySelector('button[aria-label=\"Más acciones del mensaje\"]')");
    await shot('canal-acciones-390');
    await click("document.querySelector('button[aria-label=\"Miembros\"]')");
    await shot('canal-miembros-390');
    await click("document.querySelector('button[aria-label=\"Cerrar lista de miembros\"]')");
    await waitFor("document.querySelector('button[aria-label=\"Miembros\"]')?.getAttribute('aria-expanded') === 'false'");
    await click("document.querySelector('button[aria-label=\"Miembros\"]')");
    await evaluate('history.back()');
    await waitFor("document.querySelector('button[aria-label=\"Miembros\"]')?.getAttribute('aria-expanded') === 'false'");
    await click("document.querySelector('button[aria-label=\"Miembros\"]')");
    await click("document.querySelector('button[aria-label=\"Cerrar miembros\"]')");
    await sleep(300);
    await click("document.querySelector('button[title=\"Ajustes\"]')");
    await waitFor("document.body.innerText.toLowerCase().includes('prueba de micrófono')");
    await shot('ajustes-voz-390');
    await evaluate("(() => { const el = document.querySelector('[class*=\"max-w-2xl\"] .overflow-y-auto'); if (el) el.scrollTop = el.scrollHeight; })()");
    await sleep(250);
    await shot('ajustes-voz-final-390');
    await click("[...document.querySelectorAll('button')].find(b => b.innerText.includes('Calidad de vídeo'))");
    await shot('ajustes-video-390');
    await click("[...document.querySelectorAll('button')].find(b => b.innerText.includes('Notificaciones'))");
    await shot('ajustes-notificaciones-390');
    await evaluate("(() => { const el = document.querySelector('[class*=\"max-w-2xl\"] .overflow-y-auto'); if (el) el.scrollTop = el.scrollHeight; })()");
    await sleep(250);
    await shot('ajustes-notificaciones-final-390');

    await navigate();
    await waitFor("document.body.innerText.includes('Servidor de prueba') || document.body.innerText.includes('Este es un mensaje de prueba')");
    await click("document.querySelector('button[title=\"Mensajes directos\"]')");
    await click("[...document.querySelectorAll('button')].find(b => b.innerText.includes('Otra Persona'))");
    await waitFor("document.body.innerText.includes('Conversación privada legible')");
    await shot('mensajes-directos-390');

    await navigate(true);
    await waitFor("document.body.innerText.includes('Telemetría del Sistema')");
    await shot('administracion-390');

    await size(1280);
    await navigate();
    await openChannel();
    await shot('canal-escritorio-1280');
    await click("document.querySelector('button[title=\"Ajustes\"]')");
    await shot('ajustes-escritorio-1280');
    await navigate(true);
    await shot('administracion-escritorio-1280');
  } finally {
    browser.kill('SIGTERM');
    await new Promise(resolve => browser.once('close', resolve));
    await rm(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });