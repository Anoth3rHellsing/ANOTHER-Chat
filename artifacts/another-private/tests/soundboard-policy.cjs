#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const storage = new Map();

function load(name) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', `${name}.ts`), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'localStorage', code)(module, module.exports, {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  });
  return module.exports;
}

const { loadSoundboardSettings, saveSoundboardSettings } = load('soundboard-settings');
const { isPlayableSoundboardUrl, isSoundboardPlayEvent } = load('soundboard-playback');
const first = loadSoundboardSettings(201);
assert.deepEqual(first, { volume: 0.5, muted: false });
assert.equal(saveSoundboardSettings(201, { volume: 0.23, muted: true }), true);
assert.deepEqual(loadSoundboardSettings(201), { volume: 0.23, muted: true });
assert.deepEqual(loadSoundboardSettings(202), { volume: 0.5, muted: false });
storage.set('anp_soundboard_settings_203', '{"volume":12,"muted":"false"}');
assert.deepEqual(loadSoundboardSettings(203), { volume: 1, muted: false });
assert.equal(isPlayableSoundboardUrl('/api/soundboard/clips/17/audio'), true);
for (const url of ['https://evil.invalid/audio', '//evil.invalid/audio', '/api/uploads/soundboard-abc.mp3',
  '/api/soundboard/clips/0/audio', '/api/soundboard/clips/17/audio?redirect=evil']) {
  assert.equal(isPlayableSoundboardUrl(url), false, `rejected URL: ${url}`);
}
const valid = {
  type: 'soundboard:play',
  data: {
    clipId: 17, serverId: 3, url: '/api/soundboard/clips/17/audio',
    name: 'Test', triggeredById: 201, triggeredByName: 'Member',
    callType: 'dm', peerId: 202,
  },
};
assert.equal(isSoundboardPlayEvent(valid), true);
assert.equal(isSoundboardPlayEvent({ ...valid, data: { ...valid.data, peerId: undefined } }), false);
console.log('Soundboard policy checks passed: account-scoped settings, volume normalization, scoped audio URLs and event shape.');