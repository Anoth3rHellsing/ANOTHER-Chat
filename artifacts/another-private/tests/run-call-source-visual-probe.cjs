#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
const url = process.env.CALL_SOURCE_VISUAL_URL ??
  'http://127.0.0.1:19327/tests/call-source-visual-probe.html';
const profile = await mkdtemp(join(tmpdir(), 'call-source-visual-'));
const browser = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
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
  assert.ok(page, `Synthetic source-visual page did not open: ${stderr.slice(-1500)}`);
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  
  let report = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const status = await evaluate('window.testStatus');
    if (status) {
      const logs = await evaluate('window.testLogs');
      report = {
        status,
        logs: logs.filter(l => l.includes('PASS') || l.includes('FAIL'))
      };
      break;
    }
    await sleep(250);
  }
  
  if (!report) {
    throw new Error('Test timed out. InnerText: ' + await evaluate('document.body ? document.body.innerText : document.documentElement.innerText'));
  }
  
  assert.equal(report.status, 'passed', JSON.stringify(report.logs, null, 2));
  
  console.log(JSON.stringify(report, null, 2));

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