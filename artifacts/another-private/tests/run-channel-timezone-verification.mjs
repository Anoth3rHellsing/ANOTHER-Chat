// Isolated browser-only check of the formatter used by channel-events.tsx.
// No authentication, API requests, database, or owner data are involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.env.CHANNEL_TIMEZONE_URL
  ?? 'http://127.0.0.1:19327/tests/channel-timezone-probe.html';
const browserBin = process.env.CHROMIUM_BIN ?? 'chromium';
const zones = [
  { timezone: 'America/Bogota', key: 'bogota', expectedHours: ['15:00', '15:00'] },
  { timezone: 'Europe/Madrid', key: 'madrid', expectedHours: ['22:00', '21:00'] },
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runInTimezone({ timezone, key, expectedHours }) {
  const profile = await mkdtemp(join(tmpdir(), 'channel-timezone-'));
  const browser = spawn(browserBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    'about:blank',
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
      const message = JSON.parse(input.subarray(0, end).toString());
      input = input.subarray(end + 1);
      if (!message.id) continue;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
      else request?.resolve(message.result);
    }
  });

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP request timed out: ${method}`));
    }, 10000);
    pending.set(id, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });

  const evaluate = async (sessionId, expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  };

  try {
    let page;
    for (let attempt = 0; attempt < 80; attempt++) {
      const { targetInfos } = await send('Target.getTargets');
      page = targetInfos.find(target => target.type === 'page' && target.url === 'about:blank');
      if (page) break;
      await sleep(100);
    }
    assert.ok(page, `Chromium did not create a page: ${stderr.slice(-1000)}`);

    const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await send('Emulation.setTimezoneOverride', { timezoneId: timezone }, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = await evaluate(sessionId, 'window.timezoneProbeReady === true');
        if (ready) break;
      } catch {
        // The page may still be navigating or Vite may still be transforming the probe.
      }
      await sleep(100);
    }
    assert.ok(ready, `Timezone probe did not render at ${url}. Browser: ${stderr.slice(-1200)}`);

    const snapshot = await evaluate(sessionId, `(() => {
      const text = selector => document.querySelector(selector)?.textContent?.trim() ?? null;
      const visible = selector => {
        const element = document.querySelector(selector);
        return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
      };
      return {
        browserTimezone: text('[data-testid="browser-timezone"]'),
        events: ['summer', 'winter'].map(id => ({
          id,
          formatted: text('[data-testid="formatted-' + id + '"]'),
          timezone: text('[data-testid="timezone-' + id + '"]'),
          iso: text('[data-testid="iso-' + id + '"]'),
          isoAttribute: document.querySelector('[data-testid="event-' + id + '"]')?.getAttribute('data-iso') ?? null,
          input: text('[data-testid="input-' + id + '"]'),
          utc: text('[data-testid="utc-' + id + '"]'),
          roundtrip: text('[data-testid="roundtrip-' + id + '"]'),
          visible: visible('[data-testid="formatted-' + id + '"]'),
        })),
        dstGap: text('[data-testid="dst-gap"]'),
        dstOverlap: text('[data-testid="dst-overlap"]'),
      };
    })()`);

    assert.equal(snapshot.browserTimezone, `Browser timezone: ${timezone}`);
    const expected = [
      {
        iso: '2027-07-15T20:00:00.000Z',
        date: new Date('2027-07-15T20:00:00.000Z'),
        localInput: key === 'bogota' ? '2027-07-15T15:00' : '2027-07-15T22:00',
      },
      {
        iso: '2027-01-15T20:00:00.000Z',
        date: new Date('2027-01-15T20:00:00.000Z'),
        localInput: key === 'bogota' ? '2027-01-15T15:00' : '2027-01-15T21:00',
      },
    ];
    for (let index = 0; index < expected.length; index++) {
      const actual = snapshot.events[index];
      const event = expected[index];
      const expectedFormatted = new Intl.DateTimeFormat('es', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(event.date);
      const expectedUtc = event.iso;

      assert.equal(actual.visible, true, `${actual.id} formatted event time is not visible`);
      assert.equal(actual.formatted, expectedFormatted, `${actual.id} localized date/time mismatch`);
      assert.ok(actual.formatted.includes(expectedHours[index]), `${actual.id} expected ${expectedHours[index]}: ${actual.formatted}`);
      assert.equal(actual.timezone, `Zona horaria (tú): ${timezone}`);
      assert.equal(actual.iso, `ISO original: ${event.iso}`);
      assert.equal(actual.isoAttribute, event.iso);
      assert.equal(actual.input, `datetime-local: ${event.localInput}`);
      assert.equal(actual.utc, `UTC convertido: ${expectedUtc}`);
      assert.equal(actual.roundtrip, `datetime-local reconstruido: ${event.localInput}`);
    }
    const expectedDstValid = key === 'bogota' ? 'true' : 'false';
    assert.ok(snapshot.dstGap.includes(`valid=${expectedDstValid}`), `DST gap handling: ${snapshot.dstGap}`);
    assert.ok(snapshot.dstOverlap.includes(`valid=${expectedDstValid}`), `DST overlap handling: ${snapshot.dstOverlap}`);

    return {
      timezone,
      events: snapshot.events.map(({ id, formatted, timezone: zoneLabel, iso, input, utc, roundtrip }) => ({
        id, formatted, timezone: zoneLabel, iso, input, utc, roundtrip,
      })),
      dstGap: snapshot.dstGap,
      dstOverlap: snapshot.dstOverlap,
    };
  } finally {
    try { await send('Browser.close'); } catch { /* Chromium may already have exited. */ }
    if (browser.exitCode === null) {
      browser.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => browser.once('exit', resolve)),
        sleep(1500),
      ]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    await rm(profile, { recursive: true, force: true });
  }
}

const results = await Promise.all(zones.map(runInTimezone));
for (const result of results) {
  console.log(`PASS isolated ${result.timezone}`);
  console.log(JSON.stringify(result, null, 2));
}
console.log('PASS two isolated Chromium profiles; these are timezone simulations, not separate user accounts.');