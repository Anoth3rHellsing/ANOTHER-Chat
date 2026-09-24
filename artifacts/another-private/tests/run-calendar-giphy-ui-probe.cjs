#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const root = process.env.UI_PROBE_URL ?? 'http://127.0.0.1:19327';
  const initial = `${root}/tests/calendar-channel-probe.html`;
  const profile = await mkdtemp(join(tmpdir(), 'calendar-gif-ui-'));
  const browser = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, initial,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let input = Buffer.alloc(0);
  let serial = 0;
  const pending = new Map();
  browser.stdio[4].on('data', data => {
    input = Buffer.concat([input, data]);
    let end;
    while ((end = input.indexOf(0)) !== -1) {
      const response = JSON.parse(input.subarray(0, end).toString());
      input = input.subarray(end + 1);
      if (!response.id) continue;
      const resolve = pending.get(response.id);
      pending.delete(response.id);
      if (response.error) resolve?.reject(new Error(JSON.stringify(response.error)));
      else resolve?.resolve(response.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  try {
    await sleep(1000);
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(target => target.type === 'page' && target.url.startsWith(initial));
    assert.ok(page, 'No abrió la prueba visual');
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const wait = async (expression, message) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error(message);
    };
    const click = async selector => {
      const ok = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
      assert.ok(ok, `No se encuentra ${selector}`);
    };
    const setInput = async (selector, value) => {
      const ok = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(node, ${JSON.stringify(value)});
        node.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      assert.ok(ok, `No se encuentra ${selector}`);
    };

    await wait('!!document.querySelector("[data-testid=channel-type-calendar]")', 'No se ve el tipo calendario');
    assert.ok((await evaluate('document.querySelector("[data-testid=channel-type-voice]").innerText')).includes('llamadas de voz'));
    await click('[data-testid=channel-type-calendar]');
    await setInput('[data-testid=input-channel-name]', 'agenda-prueba');
    await click('[data-testid=button-create-channel]');
    await wait('window.calendarChannelProbe?.channel?.channelType === "calendar"', 'No creó un canal calendario');
    await wait('!!document.querySelector("[data-testid=channel-calendar-content]")', 'El calendario no ocupa el canal');
    await click('[data-testid=button-create-event]');
    await wait('!!document.querySelector("[data-testid=input-event-title]")', 'No abre creación de evento');
    await setInput('[data-testid=input-event-title]', 'Evento sintético');
    const future = await evaluate('new Date(Date.now() + 86400000).toISOString().slice(0, 16)');
    await setInput('[data-testid=input-event-starts-at]', future);
    await click('[data-testid=button-save-event]');
    await wait('window.calendarChannelProbe?.events?.length === 1', 'No creó el evento');
    await wait('document.body.innerText.includes("Evento sintético")', 'Evento no visible en el calendario');
    await wait('!!document.querySelector("[data-testid=event-item-8801] [role=button]")', 'No aparece la tarjeta del evento');
    await click('[data-testid=event-item-8801] [role=button]');
    await click('[aria-label="Responder Asistiré"]');
    await wait('window.calendarChannelProbe?.events?.[0]?.myResponse?.status === "yes"', 'No registró la asistencia');
    console.log('PASS calendario: tipo, voz descriptiva, creación, vista principal, evento y asistencia con interfaz real y API simulada');

    await send('Page.navigate', { url: `${root}/tests/giphy-picker-probe.html` }, sessionId);
    await wait('!!window.gifProbe && !!document.querySelector("[role=dialog]")', 'No abrió selector GIF');
    await wait('window.gifProbe.requests.some(p => p.startsWith("/api/giphy/search?"))', 'No pidió tendencias');
    assert.equal(await evaluate('document.querySelector("[role=dialog]").innerText.includes("Powered by GIPHY")'), true);
    assert.equal(await evaluate('window.gifProbe.requests.some(p => p.includes("api_key"))'), false);
    await setInput('[aria-label="Buscar GIF"]', 'gato');
    await wait('window.gifProbe.requests.some(p => p.includes("q=gato"))', 'No buscó GIF');
    await wait('!!document.querySelector("[aria-label^=\\"Enviar GIF:\\"]")', 'No aparecen GIF');
    await click('[aria-label^="Enviar GIF:"]');
    await wait('!!document.querySelector("[data-message-content-type=giphy-gif]")', 'GIF no renderizado como mensaje');
    console.log('PASS GIF: tendencias, búsqueda, atribución, selección y renderizado; sin clave en solicitudes del navegador');

    await send('Page.navigate', { url: `${root}/tests/giphy-picker-probe.html?unavailable=1` }, sessionId);
    await wait('document.body?.innerText?.includes("falta configurar GIPHY") ?? false', 'No explica ausencia de clave');
    assert.equal(await evaluate('window.gifProbe.requests.some(p => p.startsWith("/api/giphy/search"))'), false);
    console.log('PASS GIF sin clave: selector no disponible, sin búsquedas y sin bloquear el campo');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    browser.kill('SIGTERM');
    await new Promise(resolve => browser.once('close', resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });