// Browser-only lifecycle regression. No authentication, database, or owner data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.WATCH_LIFECYCLE_URL ?? 'http://127.0.0.1:19327/tests/watch-lifecycle-probe.html';
const profile = await mkdtemp(join(tmpdir(), 'watch-lifecycle-'));
const browser = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--remote-debugging-pipe', `--user-data-dir=${profile}`, url,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
browser.stderr.on('data', chunk => { stderr += chunk.toString(); });
let input = Buffer.alloc(0);
let serial = 0;
const pending = new Map();
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
  await sleep(1200);
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find(target => target.type === 'page' && target.url.startsWith(url));
  assert.ok(page, `No test page found: ${stderr.slice(-1000)}`);
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };
  const state = () => evaluate('window.watchState');
  const waitFor = async id => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await state())?.current === id) {
        await sleep(120);
        return;
      }
      await sleep(100);
    }
    throw new Error(`Expected current ${id}, got ${JSON.stringify(await state())}: ${stderr.slice(-1000)}`);
  };
  await waitFor('yt1');
  await evaluate('window.watchLifecycle.finish()');
  await waitFor('sc1');
  await evaluate('window.watchLifecycle.finish()');
  await waitFor('yt2');
  await evaluate('window.watchLifecycle.advance()');
  await waitFor('sc2');
  await evaluate('window.watchLifecycle.advance()');
  await waitFor('yt3');
  await evaluate('window.watchLifecycle.advance()');
  await waitFor('sc3');
  assert.match(await evaluate('document.querySelector("[data-testid=status-watch-player-error]")?.textContent || ""'),
    /Simulated SoundCloud initialization failure/);
  await evaluate('window.watchLifecycle.advance()');
  await waitFor(null);

  const { log, errors, empty, overlay } = await evaluate(`({
    log: window.watchLifecycle.log, errors: window.watchLifecycle.errors,
    empty: !!document.querySelector('[data-testid="queue-empty"]'),
    overlay: !!document.querySelector('vite-error-overlay, replit-error-overlay, [data-testid="error-overlay"]'),
  })`);
  assert.deepEqual(errors, [], `Uncaught browser errors: ${errors.join('; ')}`);
  assert.equal(overlay, false, 'Development error overlay appeared');
  assert.equal(empty, true, 'Empty queue did not remove the player');
  const created = log.filter(entry => entry.event.endsWith('.create')).map(entry => entry.item);
  assert.deepEqual(created, ['yt1', 'sc1', 'yt2', 'sc2', 'yt3']);
  for (const id of ['yt1', 'yt2', 'yt3']) {
    assert.equal(log.find(entry => entry.event === 'yt.destroy' && entry.item === id)?.attached, true,
      `YouTube ${id} was removed before destroy()`);
  }
  for (const id of ['sc1', 'sc2']) {
    assert.equal(log.find(entry => entry.event === 'sc.pause' && entry.item === id)?.attached, true,
      `SoundCloud ${id} was removed before pause()`);
    assert.equal(log.find(entry => entry.event === 'sc.unbind' && entry.item === id)?.attached, true,
      `SoundCloud ${id} was removed before unbind()`);
  }
  for (const [left, right] of [['yt1', 'sc1'], ['sc1', 'yt2'], ['yt2', 'sc2'], ['sc2', 'yt3']]) {
    const teardown = log.findIndex(entry => entry.item === left
      && (entry.event === 'yt.destroy' || entry.event === 'sc.unbind'));
    const setup = log.findIndex(entry => entry.item === right && entry.event.endsWith('.create'));
    assert.ok(teardown >= 0 && setup > teardown, `${left} was not destroyed before ${right} initialized`);
  }
  console.log('PASS native finishes, manual skips, current-item removals, cross-platform transitions, and empty queue');
  console.log('PASS teardown preceded new initialization; SDK replacement and teardown/init failures produced no uncaught errors or overlay');
  const capture = await evaluate(`(async () => {
    const {callMediaConstraints} = await import('/src/lib/settings-utils.ts');
    const voice = callMediaConstraints('', 'medium');
    const dm = callMediaConstraints('', 'medium');
    const withCamera = callMediaConstraints('specific-microphone', 'high', true);
    const voiceStream = await navigator.mediaDevices.getUserMedia(voice);
    const dmStream = await navigator.mediaDevices.getUserMedia(dm);
    const result = {
      voice, dm, withCamera, voiceTracks: voiceStream.getAudioTracks().length,
      dmTracks: dmStream.getAudioTracks().length,
      settings: voiceStream.getAudioTracks()[0]?.getSettings(),
    };
    voiceStream.getTracks().forEach(track => track.stop());
    dmStream.getTracks().forEach(track => track.stop());
    return result;
  })()`);
  assert.deepEqual(capture.voice, capture.dm);
  assert.deepEqual(capture.voice.audio, {
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  });
  assert.equal(capture.voice.video, false);
  assert.equal(capture.withCamera.audio.deviceId.exact, 'specific-microphone');
  assert.equal(capture.withCamera.video.deviceId, undefined, 'Audio input leaked into video constraints');
  assert.equal(capture.withCamera.video.width, 1280);
  assert.equal(capture.voiceTracks, 1);
  assert.equal(capture.dmTracks, 1);
  console.log('PASS shared voice/DM microphone constraints and two synthetic microphone captures:', JSON.stringify(capture.settings));
} finally {
  browser.kill();
  await new Promise(resolve => browser.once('close', resolve));
  await rm(profile, { recursive: true, force: true });
}