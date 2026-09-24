// Optional live probe. Uses a disposable browser profile and a public example track.
// Run manually: node artifacts/another-private/tests/probe-soundcloud-widget.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const track = process.env.WATCH_TEST_TRACK ?? 'https://soundcloud.com/forss/flickermood';
const profile = await mkdtemp(join(tmpdir(), 'watch-soundcloud-'));
const html = `<!doctype html><meta charset="utf-8">
<button id="activate">Activate audio</button>
<iframe id="player" title="Official SoundCloud player" width="500" height="300"
  allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(track)}&auto_play=false&visual=true&single_active=true"></iframe>
<script src="https://w.soundcloud.com/player/api.js"></script>
<script>
window.events = [];
window.widget = SC.Widget(document.getElementById('player'));
for (const name of ['READY', 'PLAY', 'PAUSE', 'PLAY_PROGRESS', 'ERROR', 'SEEK']) {
  window.widget.bind(SC.Widget.Events[name], () => window.events.push(name));
}
window.readVolume = () => new Promise(resolve => window.widget.getVolume(resolve));
window.readPosition = () => new Promise(resolve => window.widget.getPosition(resolve));
document.getElementById('activate').onclick = () => { window.widget.setVolume(60); window.widget.play(); };
</script>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const pageUrl = process.env.WATCH_TEST_PAGE ?? `http://127.0.0.1:${port}/`;
const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', `--remote-debugging-pipe`,
  `--user-data-dir=${profile}`, pageUrl,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
chrome.stderr.on('data', () => {});
// Meter-only verification: discard samples immediately; never save media.
const monitor = spawn('parec', ['--device=null.monitor', '--raw', '--format=s16le', '--rate=44100', '--channels=2']);
let sumSquares = 0;
let sampleCount = 0;
monitor.stdout.on('data', data => {
  for (let i = 0; i + 1 < data.length; i += 2) {
    const sample = data.readInt16LE(i) / 32768;
    sumSquares += sample * sample;
    sampleCount++;
  }
});
const meter = () => {
  const rms = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
  sumSquares = 0;
  sampleCount = 0;
  return Number(rms.toFixed(6));
};

let sequence = 0;
const pending = new Map();
let input = Buffer.alloc(0);
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  chrome.stdio[3].write(`${JSON.stringify({ id, method, params })}\0`);
});
chrome.stdio[4].on('data', bytes => {
  input = Buffer.concat([input, bytes]);
  let end;
  while ((end = input.indexOf(0)) >= 0) {
    const message = JSON.parse(input.subarray(0, end).toString());
    input = input.subarray(end + 1);
    if (!message.id) continue;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
    else request?.resolve(message.result);
  }
});
const sleep = delay => new Promise(resolve => setTimeout(resolve, delay));
try {
  await sleep(3000);
  const { targetInfos } = await send('Target.getTargets');
  const page = targetInfos.find(info => info.type === 'page' && info.url.startsWith(pageUrl));
  if (!page) throw new Error('No browser page found');
  const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const pageSend = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    chrome.stdio[3].write(`${JSON.stringify({ id, sessionId, method, params })}\0`);
  });
  const pageEvaluate = async expression => {
    const result = await pageSend('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await pageEvaluate('window.events || []')).includes('READY')) break;
    await sleep(1000);
  }
  const events = await pageEvaluate('window.events');
  if (!events.includes('READY')) throw new Error(`Widget not ready: ${JSON.stringify(events)}`);
  for (const level of [60, 0, 25, 100, 60]) {
    const before = await pageEvaluate('window.readVolume()');
    const operation = process.env.WATCH_TEST_PAGE ? `window.setWatchVolume(${level / 100})` : `window.widget.setVolume(${level})`;
    const after = await pageEvaluate(`(async () => { ${operation}; await new Promise(r => setTimeout(r, 500)); return window.readVolume() })()`);
    console.log(`volume ${before} -> ${after}, requested ${level}`);
  }
  await pageEvaluate('window.widget.play()');
  await sleep(3000);
  console.log('after play:', await pageEvaluate('(async () => ({volume: await window.readVolume(), position: await window.readPosition(), paused: await new Promise(r => window.widget.isPaused(r)), warning: document.querySelector("[data-testid=status-watch-player-error]")?.textContent ?? null, events: window.events.slice(-8)}))()'), 'audio RMS', meter());
  await pageEvaluate('window.widget.seekTo(12000)');
  await sleep(1200);
  console.log('after seek:', await pageEvaluate('(async () => ({volume: await window.readVolume(), position: await window.readPosition(), events: window.events.slice(-8)}))()'));
  await pageEvaluate('window.widget.pause()');
  console.log('after pause:', await pageEvaluate('(async () => ({volume: await window.readVolume(), paused: await new Promise(r => window.widget.isPaused(r))}))()'));
  const click = async selector => {
    await pageEvaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:"center"})`);
    await sleep(150);
    const { root } = await pageSend('DOM.getDocument');
    const { nodeId } = await pageSend('DOM.querySelector', { nodeId: root.nodeId, selector });
    const { model } = await pageSend('DOM.getBoxModel', { nodeId });
    const [x0, y0, x2, y2] = model.content;
    const x = (x0 + x2) / 2;
    const y = (y0 + y2) / 2;
    await pageSend('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await pageSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  await click('#activate');
  await sleep(1000);
  console.log('after gesture:', await pageEvaluate('(async () => ({volume: await window.readVolume(), paused: await new Promise(r => window.widget.isPaused(r))}))()'));
  meter();
  await sleep(3500);
  console.log('audible volume 60:', await pageEvaluate('(async () => ({volume: await window.readVolume(), paused: await new Promise(r => window.widget.isPaused(r)), position: await window.readPosition()}))()'), 'audio RMS', meter());
  await pageEvaluate(process.env.WATCH_TEST_PAGE ? 'window.setWatchVolume(0)' : 'window.widget.setVolume(0)');
  await sleep(800);
  meter();
  await sleep(2000);
  console.log('muted volume 0:', await pageEvaluate('window.readVolume()'), 'audio RMS', meter());
  await pageEvaluate(process.env.WATCH_TEST_PAGE ? 'window.setWatchVolume(0.25)' : 'window.widget.setVolume(25)');
  await sleep(2500);
  console.log('low volume 25:', await pageEvaluate('window.readVolume()'), 'audio RMS', meter());
  await pageEvaluate(process.env.WATCH_TEST_PAGE ? 'window.setWatchVolume(0.6)' : 'window.widget.setVolume(60)');
  await sleep(2500);
  console.log('restored volume 60:', await pageEvaluate('window.readVolume()'), 'audio RMS', meter());
  await pageEvaluate('window.widget.pause()');
  await sleep(800);
  meter();
  await sleep(2000);
  console.log('widget paused:', await pageEvaluate('(async () => ({volume: await window.readVolume(), paused: await new Promise(r => window.widget.isPaused(r)), position: await window.readPosition()}))()'), 'audio RMS', meter());
  const iframe = (await send('Target.getTargets')).targetInfos.find(t => t.type === 'iframe' && t.url.includes('w.soundcloud.com/player/'));
  if (iframe) {
    const { sessionId: frameSession } = await send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
    const id = ++sequence;
    const frameResult = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    chrome.stdio[3].write(`${JSON.stringify({
      id, sessionId: frameSession, method: 'Runtime.evaluate',
      params: {
        expression: 'Array.from(document.querySelectorAll("audio,video")).map(m => ({muted:m.muted,volume:m.volume,paused:m.paused,currentTime:m.currentTime,readyState:m.readyState}))',
        returnByValue: true,
      },
    })}\0`);
    console.log('iframe HTML media:', (await frameResult).result.value);
  }
} finally {
  monitor.kill();
  chrome.kill();
  await new Promise(resolve => chrome.once('close', resolve));
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}