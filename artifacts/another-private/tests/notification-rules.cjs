#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Load only the pure rule/settings modules; no app session or user data is created.
const modules = new Map();
const localStorage = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name).exports;
  const filename = path.join(__dirname, '..', 'src', 'lib', `${name}.ts`);
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  modules.set(name, module);
  const requireLocal = specifier => {
    if (!specifier.startsWith('./')) throw new Error(`Unexpected dependency: ${specifier}`);
    return load(specifier.slice(2));
  };
  new Function('module', 'exports', 'require', 'localStorage', code)(
    module, module.exports, requireLocal, {
      getItem: key => localStorage.get(key) ?? null,
      setItem: (key, value) => localStorage.set(key, value),
    },
  );
  return module.exports;
}

const {
  loadNotificationSettings, saveNotificationSettings, resolveChannelLevel,
} = load('notification-settings');
const { shouldAlertForMessage, isNotificationsMuted } = load('notification-rules');
const settings = loadNotificationSettings(101);
const channel = (patch = {}) => ({
  settings, kind: 'channel', own: false, viewingFocused: false,
  serverId: 7, channelId: 13, ...patch,
});
let passed = 0;
function check(value, message) {
  assert.equal(value, true, message);
  passed++;
  console.log(`PASS ${message}`);
}

check(settings.showPreview === false && settings.browserEnabled === false,
  'message content is hidden and OS notifications are opt-in by default');
check(settings.soundEnabled && resolveChannelLevel(settings, 7, 13) === 'mentions',
  'sound is enabled and server channels default to mentions');
check(!shouldAlertForMessage(channel()), 'an ordinary server message does not alert by default');
check(shouldAlertForMessage(channel({ mentioned: true })), 'a direct mention alerts by default');
check(shouldAlertForMessage({ settings, kind: 'dm', own: false, viewingFocused: false }),
  'direct messages alert by default');
check(shouldAlertForMessage({ settings, kind: 'group', own: false, viewingFocused: false }),
  'group direct messages alert by default');
check(!shouldAlertForMessage(channel({ own: true, mentioned: true })),
  'own messages never alert, even if marked as a mention');
check(!shouldAlertForMessage(channel({ mentioned: true, viewingFocused: true })),
  'focused conversation never alerts');
check(!shouldAlertForMessage({ settings, kind: 'dm', own: false, viewingFocused: true }),
  'focused direct conversation never alerts');

settings.serverLevels['7'] = 'none';
settings.channelLevels['13'] = 'all';
check(shouldAlertForMessage(channel()), 'explicit channel all overrides server none');
settings.channelLevels['13'] = 'none';
settings.serverLevels['7'] = 'all';
check(!shouldAlertForMessage(channel({ mentioned: true })),
  'explicit channel none overrides server all, even for mentions');
delete settings.channelLevels['13'];
check(shouldAlertForMessage(channel()), 'inherited server all alerts on ordinary messages');

const now = Date.now();
settings.muteUntil = now + 60_000;
check(isNotificationsMuted(settings, now) &&
  !shouldAlertForMessage(channel({ now })) &&
  !shouldAlertForMessage({ settings, kind: 'dm', own: false, viewingFocused: false, now }) &&
  !shouldAlertForMessage({ settings, kind: 'group', own: false, viewingFocused: false, now }),
'global timed mute suppresses server, DM and group alert decisions');
check(!isNotificationsMuted(settings, now + 60_001), 'mute expires automatically by timestamp');

settings.muteUntil = null;
saveNotificationSettings(101, settings);
check(loadNotificationSettings(101).serverLevels['7'] === 'all', 'settings persist for the same user');
check(resolveChannelLevel(loadNotificationSettings(102), 7, 13) === 'mentions',
  'another user in the same browser does not inherit those settings');
localStorage.set('anp_notification_settings_103', '{"showPreview":"true","serverLevels":{"7":"invalid"}}');
check(loadNotificationSettings(103).showPreview === false &&
  resolveChannelLevel(loadNotificationSettings(103), 7, 13) === 'mentions',
  'invalid stored values fall back to privacy-safe defaults');

console.log(`${passed} notification policy checks passed; no real message or permission UI was exercised.`);