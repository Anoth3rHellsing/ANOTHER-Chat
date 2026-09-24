#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const sourcePath = path.join(__dirname, '..', 'src', 'lib', 'watch-session.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledModule = { exports: {} };
new Function('module', 'exports', compiled)(compiledModule, compiledModule.exports);
const {
  clampWatchVolume,
  expectedWatchPosition,
  isWatchStateMessage,
  normalizeWatchUrl,
  shouldCorrectWatchDrift,
} = compiledModule.exports;

const youtube = normalizeWatchUrl('https://youtu.be/aqz-KE-bpKQ?t=12');
assert.deepEqual(youtube, {
  ok: true,
  platform: 'youtube',
  contentId: 'aqz-KE-bpKQ',
  canonicalUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
});
assert.deepEqual(normalizeWatchUrl('http://m.youtube.com/shorts/aqz-KE-bpKQ?feature=share'), {
  ok: true,
  platform: 'youtube',
  contentId: 'aqz-KE-bpKQ',
  canonicalUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
});
assert.deepEqual(normalizeWatchUrl('https://soundcloud.com/an-artist/a-track?si=abc'), {
  ok: true,
  platform: 'soundcloud',
  contentId: 'an-artist/a-track',
  canonicalUrl: 'https://soundcloud.com/an-artist/a-track',
});
const unicodeTrack = normalizeWatchUrl('https://m.soundcloud.com/élodie/café');
assert.deepEqual(unicodeTrack, {
  ok: true,
  platform: 'soundcloud',
  contentId: 'élodie/café',
  canonicalUrl: 'https://soundcloud.com/%C3%A9lodie/caf%C3%A9',
});
assert.deepEqual(normalizeWatchUrl('https://soundcloud.com/artist/cafe%CC%81'), {
  ok: true,
  platform: 'soundcloud',
  contentId: 'artist/café',
  canonicalUrl: 'https://soundcloud.com/artist/caf%C3%A9',
});
assert.equal(normalizeWatchUrl('https://soundcloud.com/artist/track?utm_source=copy').canonicalUrl,
  'https://soundcloud.com/artist/track');
for (const url of [
  'https://youtube.com.evil.test/watch?v=aqz-KE-bpKQ',
  'https://evil.test/watch?v=aqz-KE-bpKQ',
  'javascript:alert(1)',
  'https://youtube.com/watch?v=invalid',
  'https://youtu.be/aqz-KE-bpKQ/extra',
  'https://youtu.be/aqz-KE-bpKQ//',
  'https://youtube.com/v/aqz-KE-bpKQ',
  'https://youtube.com/embed/aqz-KE-bpKQ/extra',
  'https://youtube.com/watch/?v=aqz-KE-bpKQ',
  'https://youtube.com/watch?v=aqz-KE-bpKQ&v=aqz-KE-bpKQ',
  'https://on.soundcloud.com/short',
  'https://soundcloud.com/an-artist/sets/a-list',
  'https://soundcloud.com//an-artist/a-track',
  'https://soundcloud.com/an-artist/a-track//',
  '//youtube.com/watch?v=aqz-KE-bpKQ',
]) {
  assert.equal(normalizeWatchUrl(url).ok, false, `rejected unsupported URL ${url}`);
}
assert.equal(clampWatchVolume(-1), 0);
assert.equal(clampWatchVolume(1.5), 1);
assert.equal(clampWatchVolume(Number.NaN), 0.7);

const session = {
  controllerUserId: 4,
  allowEveryone: false,
  current: {
    id: 'entry-1', platform: 'youtube', contentId: 'aqz-KE-bpKQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    addedById: 4, addedByName: 'Host', title: 'Video',
  },
  queue: [],
  playing: true,
  positionMs: 10_000,
  updatedAtMs: 100_000,
  serverNowMs: 100_000,
  revision: 1,
};
const message = { type: 'watch:state', data: { scope: 'voice', targetId: 9, session } };
assert.equal(isWatchStateMessage(message), true);
assert.equal(isWatchStateMessage({ ...message, data: { ...message.data, targetId: 0 } }), false);
assert.equal(isWatchStateMessage({ ...message, data: { ...message.data, session: {
  ...session, current: { ...session.current, canonicalUrl: 'https://evil.test/audio' },
} } }), false);
assert.equal(expectedWatchPosition(session, 104_100), 14_100);
assert.equal(expectedWatchPosition({ ...session, playing: false }, 104_100), 10_000);
assert.equal(shouldCorrectWatchDrift(10_000, 10_500), false);
assert.equal(shouldCorrectWatchDrift(10_000, 12_000), false);
assert.equal(shouldCorrectWatchDrift(10_000, 12_001), true);
console.log('Watch-session tests passed: backend-aligned link normalization, event validation, volume bounds, timestamped playback, and 2-second drift correction.');