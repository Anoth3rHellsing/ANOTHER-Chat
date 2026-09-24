#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
const url = process.env.CALL_SOURCE_AUDIO_URL ??
  'http://127.0.0.1:19327/tests/call-source-audio-probe.html';
const profile = await mkdtemp(join(tmpdir(), 'call-source-audio-'));
const browser = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  ...(process.env.CALL_SOURCE_AUDIO_DEFAULT_POLICY ? [] : ['--autoplay-policy=no-user-gesture-required']),
  '--remote-debugging-pipe', `--user-data-dir=${profile}`, url,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

let stderr = '';
let input = Buffer.alloc(0);
let serial = 0;
const pending = new Map();
browser.stderr.on('data', chunk => { stderr += chunk.toString(); });
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
  await sleep(1000);
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find(target => target.type === 'page' && target.url.startsWith(url));
  assert.ok(page, `Synthetic source-audio page did not open: ${stderr.slice(-1500)}`);
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  if (process.env.CALL_SOURCE_AUDIO_DEFAULT_POLICY) {
    const readyDeadline = Date.now() + 12000;
    while (Date.now() < readyDeadline && !await evaluate('!!window.callSourceProbe')) await sleep(100);
    assert.equal(await evaluate('!!window.callSourceProbe'), true, 'Probe never mounted before user gesture');
    // The initial AudioContext already exists; resume requires a real gesture under
    // Chromium's default autoplay policy.
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 30, y: 30, button: 'left', clickCount: 1 }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 30, y: 30, button: 'left', clickCount: 1 }, sessionId);
  }
  let report;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    report = await evaluate('window.callSourceAudioResult');
    if (report) break;
    await sleep(150);
  }
  assert.ok(report, `Audio probe timed out: ${await evaluate('document.body.innerText')}`);
  assert.equal(report.status, 'passed', JSON.stringify(report.results));
  const teardown = await evaluate(`(() => {
    const elements = [...document.querySelectorAll('audio[data-remote-audio-peer]')];
    window.__audioBeforeUnmount = elements;
    window.unmountSourceProbe();
    return elements.length;
  })()`);
  assert.equal(teardown, 4, 'Expected all peer/source elements to be mounted before teardown');
  await sleep(100);
  const released = await evaluate(`window.__audioBeforeUnmount.every(audio =>
    audio.paused && audio.srcObject === null) &&
    document.querySelectorAll('audio[data-remote-audio-peer]').length === 0`);
  assert.equal(released, true, 'Unmount did not pause and detach source streams');
  console.log(JSON.stringify({ ...report, cleanup: 'PASS elements paused/detached on call teardown' }, null, 2));
} catch (error) {
  console.error(error.message);
  if (stderr) console.error(`Chromium output:\n${stderr.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  browser.kill('SIGTERM');
  await new Promise(resolve => browser.once('close', resolve)).catch(() => undefined);
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});