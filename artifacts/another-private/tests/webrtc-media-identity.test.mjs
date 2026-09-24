import assert from 'node:assert/strict';
import {
  classifyRemoteVideoStream,
  enqueueCurrentPeerTrackOperation,
  getLiveScreenTracks,
  identifyRemoteAudioRole,
} from '../src/lib/webrtc-media-identity.ts';

const roles = new Map();

// Screen audio can arrive before either camera video or microphone audio.
roles.set('screen-stream', 'screen');
assert.equal(classifyRemoteVideoStream('camera-stream', roles), null,
  'camera video stays pending while only screen audio has established a role');
assert.equal(classifyRemoteVideoStream('screen-stream', roles), 'screen',
  'screen audio identifies its associated screen video immediately');
roles.set('camera-stream', 'microphone');
assert.equal(classifyRemoteVideoStream('camera-stream', roles), 'microphone',
  'camera video resolves to the microphone stream when mic audio arrives');
assert.equal(classifyRemoteVideoStream('screen-stream', roles), 'screen',
  'screen video retains its role after microphone audio arrives');

// With a video-only screen capture, the established microphone stream lets the
// receiver classify a distinct, previously unknown video stream as screen.
assert.equal(classifyRemoteVideoStream('camera-stream', new Map([['camera-stream', 'microphone']])),
  'microphone', 'camera stays associated with its own microphone stream');
assert.equal(classifyRemoteVideoStream('video-only-screen', new Map([['camera-stream', 'microphone']])),
  'screen', 'video-only screen resolves after microphone identity is known');
assert.equal(classifyRemoteVideoStream('camera-stream', new Map()), null,
  'unknown video remains unclassified until an audio stream establishes identity');

const microphoneTransceiver = { mid: '0' };
const screenTransceiver = { mid: '2' };
assert.equal(identifyRemoteAudioRole([microphoneTransceiver, screenTransceiver], screenTransceiver), 'screen',
  'the later negotiated audio transceiver identifies screen audio regardless of event order');

const liveVideo = { readyState: 'live' };
const endedAudio = { readyState: 'ended' };
const candidateStream = {
  getVideoTracks: () => [liveVideo],
  getAudioTracks: () => [endedAudio],
};
assert.equal(getLiveScreenTracks(candidateStream, false), null,
  'late peers cannot attach tracks from an uncommitted capture');
assert.deepEqual(getLiveScreenTracks(candidateStream, true), { video: liveVideo, audio: null },
  'late peers attach only live tracks from a committed capture');

// Hold an old share's replacement in flight, then end/clean up it and queue an
// immediate re-share. The obsolete stop must not clear the new capture's track.
const senderQueues = new Map();
const calls = [];
let activeGeneration = 1;
let activeCapture = 'first';
let currentTrack = null;
let releaseOldReplacement;
let oldReplacementEntered;
const oldEntered = new Promise(resolve => { oldReplacementEntered = resolve; });
const holdOldReplacement = new Promise(resolve => { releaseOldReplacement = resolve; });
const peerId = 7;
const queue = (generation, capture, operation, isCurrent = () => activeCapture === capture) =>
  enqueueCurrentPeerTrackOperation(
    senderQueues, peerId, generation, () => activeGeneration, isCurrent, operation,
  );
const oldReplacement = queue(1, 'first', async () => {
  oldReplacementEntered();
  await holdOldReplacement;
  calls.push('first-audio');
  currentTrack = 'first-audio';
});
await oldEntered;

const endedTrackRemoval = queue(1, 'first', async () => {
  calls.push('null-from-ended-track');
  currentTrack = null;
});
activeGeneration = 2;
activeCapture = null;
const cleanup = queue(2, null, async () => {
  calls.push('null-from-cleanup');
  currentTrack = null;
}, () => activeCapture !== 'first');
releaseOldReplacement();
await Promise.all([oldReplacement, endedTrackRemoval, cleanup]);
assert.equal(currentTrack, null, 'cleanup retires the old screen track before re-share');

activeGeneration = 3;
activeCapture = 'second';
await queue(3, 'second', async () => {
  calls.push('second-audio');
  currentTrack = 'second-audio';
});
await queue(1, 'first', async () => {
  calls.push('stale-null');
  currentTrack = null;
});
assert.equal(currentTrack, 'second-audio', 'a delayed ended/cleanup operation cannot silence the re-share');
assert.deepEqual(calls, ['first-audio', 'null-from-cleanup', 'second-audio'],
  'track replacement queue serializes cleanup before the new capture and ignores stale removal');

console.log('PASS remote track identity ordering, committed late join, and screen-audio lifecycle races');