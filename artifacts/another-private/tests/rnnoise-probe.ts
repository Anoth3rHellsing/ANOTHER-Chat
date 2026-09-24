// Isolated synthetic audio test. No call accounts, persistence, or real microphone.
import { createMicrophoneProcessor, updateNativeMicrophoneTrack } from '../src/lib/microphone-processor';
import { loadSettings, saveSettings } from '../src/lib/settings-utils';
import tapWorkletUrl from './sample-tap-worklet.js?url';

const result = document.getElementById('result')!;
const errors: string[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const inputRate = Number(new URLSearchParams(location.search).get('rate') ?? 44100);
  const sourceContext = new AudioContext({ sampleRate: inputRate });
  const meterContext = new AudioContext({ sampleRate: inputRate });
  const microphone = sourceContext.createMediaStreamDestination();
  const noise = sourceContext.createBuffer(1, inputRate * 2, inputRate);
  const samples = noise.getChannelData(0);
  let seed = 49361;
  for (let i = 0; i < samples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    samples[i] = ((seed >>> 0) / 2147483648 - 1) * 0.23;
  }
  const noiseSource = sourceContext.createBufferSource();
  noiseSource.buffer = noise;
  noiseSource.loop = true;
  noiseSource.connect(microphone);
  noiseSource.start();

  const rawTrack = microphone.stream.getAudioTracks()[0]!;
  (window as any).rnnoiseProbePhase = 'baseline';
  await sleep(3500);
  (window as any).rnnoiseProbePhase = 'initializing';
  const processor = await createMicrophoneProcessor(rawTrack, message => errors.push(message));
  (window as any).rnnoiseProbePhase = 'processing';
  await sleep(3500);
  (window as any).rnnoiseProbePhase = 'measuring';
  const rawAnalyser = meterContext.createAnalyser();
  const filteredAnalyser = meterContext.createAnalyser();
  for (const analyser of [rawAnalyser, filteredAnalyser]) analyser.fftSize = 2048;
  meterContext.createMediaStreamSource(microphone.stream).connect(rawAnalyser);
  meterContext.createMediaStreamSource(new MediaStream([processor.track])).connect(filteredAnalyser);
  await Promise.all([sourceContext.resume(), meterContext.resume()]);

  const rms = async (analyser: AnalyserNode) => {
    const buffer = new Float32Array(analyser.fftSize);
    let power = 0;
    for (let i = 0; i < 42; i++) {
      await sleep(45);
      analyser.getFloatTimeDomainData(buffer);
      power += buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length;
    }
    return Math.sqrt(power / 42);
  };
  await sleep(1200); // Wait for RNNoise's 10 ms frame state to settle.
  const rawNoise = await rms(rawAnalyser);
  const suppressedNoise = await rms(filteredAnalyser);
  const reductionDb = 20 * Math.log10(rawNoise / Math.max(suppressedNoise, 0.000001));

  // Both diagnostic taps use the same AudioContext sample clock; ScriptProcessor
  // callback timestamps vary by several milliseconds and cannot measure delay.
  await meterContext.audioWorklet.addModule(tapWorkletUrl);
  const capture = (track: MediaStreamTrack) => {
    const data = new Map<number, Float32Array>();
    const source = meterContext.createMediaStreamSource(new MediaStream([track]));
    const tap = new AudioWorkletNode(meterContext, 'sample-tap');
    tap.port.onmessage = event => data.set(event.data.frame, event.data.samples);
    source.connect(tap);
    tap.connect(meterContext.destination);
    return { data, stop: () => { source.disconnect(); tap.disconnect(); } };
  };
  const rawCapture = capture(rawTrack);
  const processedCapture = capture(processor.track);
  await sleep(1500);
  rawCapture.stop();
  processedCapture.stop();
  const rawFrames = rawCapture.data;
  const processedFrames = processedCapture.data;
  const startFrame = Math.max(
    Math.min(...rawFrames.keys()), Math.min(...processedFrames.keys()),
  ) + 4096;
  const sampleAt = (frames: Map<number, Float32Array>, frame: number): number =>
    frames.get(Math.floor(frame / 128) * 128)?.[frame % 128] ?? 0;
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = 0; lag <= 4400; lag += 2) {
    let score = 0;
    for (let i = startFrame; i < startFrame + 33000; i += 7) {
      score += sampleAt(rawFrames, i) * sampleAt(processedFrames, i + lag);
    }
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  const measuredDelayMs = bestLag * 1000 / inputRate;

  // The screen source has no connection to the RNNoise graph. Its output is a
  // separate track path, so mic processing/mute cannot alter the display tone.
  const screen = sourceContext.createMediaStreamDestination();
  const tone = sourceContext.createOscillator();
  tone.frequency.value = 880;
  const toneGain = sourceContext.createGain();
  toneGain.gain.value = 0.15;
  tone.connect(toneGain).connect(screen);
  tone.start();
  const screenSource = meterContext.createMediaStreamSource(screen.stream);
  const screenAnalyser = meterContext.createAnalyser();
  screenAnalyser.fftSize = 8192;
  screenSource.connect(screenAnalyser);

  const toneRmsDb = async () => 20 * Math.log10(Math.max(await rms(screenAnalyser), 0.000001));
  await sleep(700);
  const originalToneDb = await toneRmsDb();
  rawTrack.enabled = false;
  await sleep(500);
  const originalAfterMuteDb = await toneRmsDb();
  const screenToneChangeDb = Math.abs(originalAfterMuteDb - originalToneDb);
  if (screenToneChangeDb >= 1) {
    errors.push('El audio de pantalla sintético cambió al silenciar el micrófono');
  }
  const mutedMicRms = await rms(filteredAnalyser);
  rawTrack.enabled = true;
  await sleep(350);
  const restoredMicRms = await rms(rawAnalyser);

  // RTP track replacement changes the mic only, without a new offer/answer.
  // Chromium's fake microphone is a separate captured device here; the white
  // noise above remains an identical-input DSP measurement.
  const captured = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const capturedTrack = captured.getAudioTracks()[0]!;
  const capturedProcessor = await createMicrophoneProcessor(capturedTrack, message => errors.push(message));
  const senderPC = new RTCPeerConnection({ iceServers: [] });
  const receiverPC = new RTCPeerConnection({ iceServers: [] });
  senderPC.onicecandidate = event => {
    if (event.candidate) void receiverPC.addIceCandidate(event.candidate);
  };
  receiverPC.onicecandidate = event => {
    if (event.candidate) void senderPC.addIceCandidate(event.candidate);
  };
  let renegotiations = 0;
  senderPC.onnegotiationneeded = () => { renegotiations++; };
  const sender = senderPC.addTrack(capturedTrack, captured);
  const remoteTrack = new Promise<MediaStreamTrack>(resolve => {
    receiverPC.ontrack = event => resolve(event.track);
  });
  await senderPC.setLocalDescription(await senderPC.createOffer());
  await receiverPC.setRemoteDescription(senderPC.localDescription);
  await receiverPC.setLocalDescription(await receiverPC.createAnswer());
  await senderPC.setRemoteDescription(receiverPC.localDescription);
  const received = await remoteTrack;
  const remoteAudio = document.createElement('audio');
  remoteAudio.srcObject = new MediaStream([received]);
  document.body.appendChild(remoteAudio);
  await remoteAudio.play();
  for (let attempt = 0; attempt < 80 && senderPC.connectionState !== 'connected'; attempt++) {
    await sleep(100);
  }
  const peerConnectionState = senderPC.connectionState;
  await sleep(300);
  const initialNegotiations = renegotiations;
  const remoteAnalyser = meterContext.createAnalyser();
  remoteAnalyser.fftSize = 2048;
  meterContext.createMediaStreamSource(new MediaStream([received])).connect(remoteAnalyser);
  await sender.replaceTrack(capturedProcessor.track);
  await sleep(300);
  const filteredRemoteRms = await rms(remoteAnalyser);
  await sender.replaceTrack(capturedTrack);
  await sleep(300);
  const bypassRemoteRms = await rms(remoteAnalyser);
  const senderStats = [...(await senderPC.getStats()).values()]
    .filter(report => report.type === 'outbound-rtp' && report.kind === 'audio')
    .map(report => ({ bytesSent: report.bytesSent, totalAudioEnergy: report.totalAudioEnergy }));
  const receiverStats = [...(await receiverPC.getStats()).values()]
    .filter(report => report.type === 'inbound-rtp' && report.kind === 'audio')
    .map(report => ({ bytesReceived: report.bytesReceived, totalAudioEnergy: report.totalAudioEnergy }));
  const receivedState = { muted: received.muted, readyState: received.readyState };
  const nativeChanges: Record<string, { disabled: boolean | undefined; enabled: boolean | undefined }> = {};
  let nativeTrack = capturedTrack;
  for (const key of ['noiseSuppression', 'echoCancellation', 'autoGainControl'] as const) {
    const settings = { noiseSuppression: false, echoCancellation: false, autoGainControl: false };
    const previous = nativeTrack;
    const disabledTrack = await updateNativeMicrophoneTrack(nativeTrack, '', settings);
    if (previous !== disabledTrack) previous.stop();
    nativeTrack = disabledTrack;
    const disabled = nativeTrack.getSettings()[key];
    settings[key] = true;
    const prior = nativeTrack;
    const enabledTrack = await updateNativeMicrophoneTrack(nativeTrack, '', settings);
    if (prior !== enabledTrack) prior.stop();
    nativeTrack = enabledTrack;
    nativeChanges[key] = { disabled, enabled: nativeTrack.getSettings()[key] };
  }
  const stableSignaling = senderPC.signalingState === 'stable' &&
    receiverPC.signalingState === 'stable' && initialNegotiations === renegotiations;
  senderPC.close();
  receiverPC.close();
  remoteAudio.pause();
  remoteAudio.srcObject = null;
  remoteAudio.remove();
  capturedProcessor.stop();
  captured.getTracks().forEach(track => track.stop());
  nativeTrack.stop();

  // Exercise the real fallback guard: no AudioWorkletNode => raw track remains
  // live, while no network asset is fetched and no visible exception occurs.
  const saved = window.AudioWorkletNode;
  let fallbackReason = '';
  try {
    (window as any).AudioWorkletNode = undefined;
    await createMicrophoneProcessor(rawTrack, message => errors.push(message));
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : String(error);
  } finally {
    (window as any).AudioWorkletNode = saved;
  }
  const savedWasm = window.WebAssembly;
  let wasmFallbackReason = '';
  try {
    (window as any).WebAssembly = undefined;
    await createMicrophoneProcessor(rawTrack, message => errors.push(message));
  } catch (error) {
    wasmFallbackReason = error instanceof Error ? error.message : String(error);
  } finally {
    (window as any).WebAssembly = savedWasm;
  }

  processor.stop();
  screenSource.disconnect();
  noiseSource.stop();
  tone.stop();
  rawTrack.stop();
  screen.stream.getTracks().forEach(track => track.stop());
  await Promise.all([sourceContext.close(), meterContext.close()]);
  const firstUser = 700001;
  const secondUser = 700002;
  const differentAccount = loadSettings(secondUser);
  saveSettings(firstUser, { ...loadSettings(firstUser), advancedNoiseSuppression: false, echoCancellation: false });
  const perUserPreferences = !loadSettings(firstUser).advancedNoiseSuppression &&
    !loadSettings(firstUser).echoCancellation &&
    loadSettings(secondUser).advancedNoiseSuppression === differentAccount.advancedNoiseSuppression &&
    loadSettings(secondUser).echoCancellation === differentAccount.echoCancellation;
  localStorage.removeItem(`anp_settings_${firstUser}`);
  localStorage.removeItem(`anp_settings_${secondUser}`);
  return {
    sampleRates: [sourceContext.sampleRate, 48000, meterContext.sampleRate],
    rawNoise, suppressedNoise, reductionDb, measuredDelayMs, bestScore,
    filteredRemoteRms, bypassRemoteRms, stableSignaling, renegotiations, peerConnectionState,
    senderStats, receiverStats, receivedState, nativeChanges,
      originalToneDb, originalAfterMuteDb, screenToneChangeDb,
      screenToneStableDuringMicMute: screenToneChangeDb < 1,
    mutedMicRms, restoredMicRms, fallbackReason, wasmFallbackReason, perUserPreferences, errors,
  };
}

void run().then(report => {
  (window as any).rnnoiseProbeResult = report;
  result.textContent = JSON.stringify(report, null, 2);
}).catch(error => {
  (window as any).rnnoiseProbeResult = { error: String(error), errors };
  result.textContent = JSON.stringify((window as any).rnnoiseProbeResult, null, 2);
});