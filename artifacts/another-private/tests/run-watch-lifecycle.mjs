// Browser-only lifecycle regression. No authentication, database, or owner data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const url = process.env.WATCH_LIFECYCLE_URL ?? 'http://127.0.0.1:19327/tests/watch-lifecycle-probe.html';
const profile = await mkdtemp(join(tmpdir(), 'watch-lifecycle-'));
const browser = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
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
const browserCpuTicks = () => {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map(row => row.trim().split(/\s+/).map(Number));
  const descendants = new Set([browser.pid]);
  for (let pass = 0; pass < 8; pass++) {
    for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid);
  }
  let ticks = 0;
  for (const pid of descendants) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      ticks += Number(stat[11]) + Number(stat[12]);
    } catch { /* A short-lived Chromium helper has exited. */ }
  }
  return ticks;
};

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
  if (process.env.AUDIO_UI_PROBE === '1') {
    let switches;
    for (let i = 0; i < 40; i++) {
      switches = await evaluate('Array.from(document.querySelectorAll("[data-testid^=switch-]")).map(item => ({ id: item.dataset.testid, checked: item.getAttribute("aria-checked") }))');
      if (switches?.length === 4) break;
      await sleep(100);
    }
    assert.equal(switches?.length, 4, 'Not all microphone settings were rendered');
    assert.ok(switches.every(item => item.checked === 'true'), 'Microphone processing defaults should be on');
    for (const id of ['switch-rnnoise', 'switch-native-noise', 'switch-native-echo', 'switch-native-gain']) {
      await evaluate(`document.querySelector('[data-testid="${id}"]').click()`);
      await sleep(50); // Let React commit each independent state update.
    }
    await sleep(200);
    const persisted = await evaluate('JSON.parse(localStorage.getItem("anp_settings_700003"))');
    assert.deepEqual(persisted && [
      persisted.advancedNoiseSuppression, persisted.noiseSuppression,
      persisted.echoCancellation, persisted.autoGainControl,
    ], [false, false, false, false]);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("[data-testid^=switch-]")).map(item => item.getAttribute("aria-checked"))'),
      ['false', 'false', 'false', 'false']);
    await evaluate('localStorage.removeItem("anp_settings_700003")');
    console.log('PASS four independent accessible switches, defaults, live UI changes and per-user browser storage');
  } else if (process.env.RNNOISE_PROBE === '1') {
    let report;
    let previousPhase;
    let phaseStart;
    const cpu = {};
    for (let attempt = 0; attempt < 240; attempt++) {
      const phase = await evaluate('window.rnnoiseProbePhase');
      if (phase && phase !== previousPhase) {
        const snapshot = { ticks: browserCpuTicks(), time: process.hrtime.bigint() };
        if (phaseStart && (previousPhase === 'baseline' || previousPhase === 'processing')) {
          const seconds = Number(snapshot.time - phaseStart.time) / 1e9;
          cpu[previousPhase] = {
            seconds: Number(seconds.toFixed(2)),
            percentOneCore: Number(((snapshot.ticks - phaseStart.ticks) / seconds).toFixed(1)),
          };
        }
        previousPhase = phase;
        phaseStart = snapshot;
      }
      report = await evaluate('window.rnnoiseProbeResult');
      if (report) break;
      await sleep(200);
    }
    assert.ok(report, `RNNoise probe timed out. Page: ${await evaluate('document.getElementById("result")?.textContent')} Browser: ${stderr.slice(-400)}`);
    console.log('Synthetic RNNoise measurements:', JSON.stringify(report));
    assert.equal(report.error, undefined, JSON.stringify(report));
    assert.deepEqual(report.errors, []);
    assert.equal(report.sampleRates[0], Number(new URL(url).searchParams.get('rate') ?? 44100));
    assert.equal(report.sampleRates[2], report.sampleRates[0]);
    assert.ok(report.reductionDb > 3, `Insufficient synthetic noise reduction: ${report.reductionDb} dB`);
    assert.equal(report.peerConnectionState, 'connected');
    assert.ok(report.filteredRemoteRms > 0.001, 'Remote voice went silent with RNNoise');
    assert.ok(report.bypassRemoteRms > 0.001, 'Remote voice went silent after bypassing RNNoise');
    assert.equal(report.stableSignaling, true, 'Hot toggles triggered renegotiation');
    assert.ok(report.measuredDelayMs > 0 && report.measuredDelayMs < 120,
      `Measured audio delay outside expected range: ${report.measuredDelayMs} ms`);
    const unsupportedNative = [];
    for (const key of ['noiseSuppression', 'echoCancellation', 'autoGainControl']) {
      assert.equal(report.nativeChanges[key]?.disabled, false,
        `Native toggle ${key} could not disable capture processing`);
      if (report.nativeChanges[key].enabled !== true) unsupportedNative.push(key);
    }
    assert.equal(report.nativeChanges.echoCancellation.enabled, true,
      'Chromium fake microphone did not re-enable echo cancellation');
    assert.ok(Math.abs(report.originalAfterMuteDb - report.mixedAfterMuteDb) < 1.5,
      'Shared-screen tone passed through RNNoise or was attenuated');
    assert.ok(report.mutedMicRms < report.rawNoise * 0.05, 'Muting the mic left voice in the mix');
    assert.match(report.fallbackReason, /AudioWorklet/);
    assert.match(report.wasmFallbackReason, /WebAssembly/);
    assert.equal(report.perUserPreferences, true, 'Audio preferences leaked between accounts');
    console.log('PASS RNNoise synthetic noise, 44.1↔48 kHz, direct display bypass, microphone mute, and fallback');
    console.log('Chromium process-tree CPU (includes browser/test overhead, percent of one core):', cpu);
    console.log('Fake-device native options unavailable when re-enabled:', unsupportedNative);
    console.log(JSON.stringify(report, null, 2));
  } else {
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
  }
} finally {
  browser.kill();
  await new Promise(resolve => browser.once('close', resolve));
  await rm(profile, { recursive: true, force: true });
}