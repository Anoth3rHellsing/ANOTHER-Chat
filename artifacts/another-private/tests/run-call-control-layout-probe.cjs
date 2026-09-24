#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const base = process.env.CALL_CONTROL_LAYOUT_URL ??
    'http://127.0.0.1:19327/tests/call-control-layout-probe.html';
  const profile = await mkdtemp(join(tmpdir(), 'call-control-layout-'));
  const browser = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-pipe', `--user-data-dir=${profile}`, `${base}?scenario=basic&sidebar=240`,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let input = Buffer.alloc(0);
  let serial = 0;
  const pending = new Map();
  browser.stderr.on('data', data => { stderr += data.toString(); });
  browser.stdio[4].on('data', bytes => {
    input = Buffer.concat([input, bytes]);
    let end;
    while ((end = input.indexOf(0)) !== -1) {
      const result = JSON.parse(input.subarray(0, end).toString());
      input = input.subarray(end + 1);
      if (!result.id) continue;
      const request = pending.get(result.id);
      pending.delete(result.id);
      if (result.error) request?.reject(new Error(JSON.stringify(result.error)));
      else request?.resolve(result.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  try {
    await sleep(900);
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(target => target.type === 'page' && target.url.startsWith(base));
    assert.ok(page, `Probe page did not open: ${stderr.slice(-1200)}`);
    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const evaluate = async expression => {
      const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const results = [];
    const scenarios = ['basic', 'muted', 'camera', 'screen', 'watch', 'soundboard', 'sources', 'invite', 'all'];
    const widths = [
      { viewport: 1280, sidebar: 240 },
      { viewport: 1024, sidebar: 200 },
      { viewport: 768, sidebar: 160 },
      { viewport: 375, sidebar: 240 },
      { viewport: 320, sidebar: 240 },
      { viewport: 280, sidebar: 120 },
      { viewport: 240, sidebar: 96 },
    ];
    for (const { viewport, sidebar } of widths) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: viewport, height: viewport <= 320 ? 568 : 800, deviceScaleFactor: 1, mobile: viewport < 768,
      }, sessionId);
      let reference = null;
      for (const scenario of scenarios) {
        await send('Page.navigate', { url: `${base}?scenario=${scenario}&sidebar=${sidebar}` }, sessionId);
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && !await evaluate('!!window.callControlProbe && !!document.querySelector("#expanded-frame button")')) {
          await sleep(70);
        }
        const measurements = await evaluate(`(() => {
          const compact = document.querySelector('#compact-frame');
          const expanded = document.querySelector('#expanded-frame');
          const bounds = el => {
            const rect = el.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
          };
          const inspect = (frame, label) => {
            const box = bounds(frame);
            const buttons = [...frame.querySelectorAll('button')].map(button => ({
              label: button.getAttribute('aria-label'),
              title: button.title,
              ...bounds(button),
            }));
            return {
              box, buttons, scrollWidth: frame.scrollWidth, clientWidth: frame.clientWidth,
              clipped: buttons.filter(button => button.left < box.left - 1 || button.right > box.right + 1),
              missingNames: buttons.filter(button => !button.label || !button.title).map(button => button.label),
            };
          };
          return {
            compact: inspect(compact, 'compact'),
            expanded: inspect(expanded, 'expanded'),
            expand: bounds(compact.querySelector('[aria-label="Expandir llamada"]')),
            hang: bounds(compact.querySelector('[aria-label="Colgar"]')),
            expandedHang: bounds(expanded.querySelector('[data-testid="button-hang-up"]')),
            minimize: bounds(expanded.querySelector('[data-testid="button-minimize-call"]')),
            viewport: document.documentElement.clientWidth,
          };
        })()`);
        const label = `${scenario} @ ${viewport}px (barra ${sidebar}px)`;
        for (const [type, measured] of [['compacta', measurements.compact], ['expandida', measurements.expanded]]) {
          assert.equal(measured.clipped.length, 0, `${label}: botones recortados en ${type}: ${JSON.stringify(measured.clipped)}`);
          assert.ok(measured.scrollWidth <= measured.clientWidth + 1,
            `${label}: ${type} desborda horizontalmente (${measured.scrollWidth} > ${measured.clientWidth})`);
          assert.deepEqual(measured.missingNames, [], `${label}: botones sin etiqueta o título en ${type}`);
        }
        const { compact, expanded, expand, hang, expandedHang, minimize } = measurements;
        assert.ok(expand.left >= compact.box.left && hang.right <= compact.box.right, `${label}: expandir/colgar fuera de la barra`);
        assert.ok(expandedHang.left >= expanded.box.left && minimize.right <= expanded.box.right,
          `${label}: colgar/minimizar fuera de la vista expandida`);
        const anchored = {
          compactExpandRight: Math.round(compact.box.right - expand.right),
          compactHangRight: Math.round(compact.box.right - hang.right),
          compactTop: Math.round(expand.top - compact.box.top),
          expandedHangRight: Math.round(expanded.box.right - expandedHang.right),
          expandedMinimizeRight: Math.round(expanded.box.right - minimize.right),
          expandedTop: Math.round(expandedHang.top - expanded.box.top),
        };
        if (reference) assert.deepEqual(anchored, reference, `${label}: la posición de controles críticos cambió`);
        else reference = anchored;
        // Drive the actual component callbacks in the reported failing states.
        if (['basic', 'watch', 'screen', 'soundboard', 'all'].includes(scenario)) {
          const clicks = await evaluate(`(() => {
            document.querySelector('#compact-frame [aria-label="Expandir llamada"]').click();
            document.querySelector('#compact-frame [aria-label="Colgar"]').click();
            document.querySelector('#expanded-frame [data-testid="button-hang-up"]').click();
            document.querySelector('#expanded-frame [data-testid="button-minimize-call"]').click();
            return new Promise(resolve => setTimeout(() => resolve(window.callControlProbe), 60));
          })()`);
          assert.equal(clicks.expanded, 1, `${label}: no se pudo expandir`);
          assert.equal(clicks.hungUp, 2, `${label}: no se pudo colgar en ambas vistas`);
          assert.equal(clicks.minimized, 1, `${label}: no se pudo minimizar`);
        }
        results.push(label);
      }
    }
    console.log(JSON.stringify({ status: 'passed', layouts: results.length, interactive: 35, widths, scenarios }, null, 2));
  } catch (error) {
    console.error(error.message);
    if (stderr) console.error(`Chromium output:\n${stderr.slice(-1000)}`);
    process.exitCode = 1;
  } finally {
    browser.kill('SIGTERM');
    await new Promise(resolve => browser.once('close', resolve)).catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });