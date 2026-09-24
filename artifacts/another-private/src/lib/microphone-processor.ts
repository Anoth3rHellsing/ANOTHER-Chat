import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import type { AudioVideoSettings } from './settings-utils';

export interface MicrophoneProcessor {
  track: MediaStreamTrack;
  stop: () => void;
}

export type NativeMicrophoneOptions = Pick<AudioVideoSettings,
  'noiseSuppression' | 'echoCancellation' | 'autoGainControl'>;

export async function updateNativeMicrophoneTrack(
  track: MediaStreamTrack,
  audioInputId: string | undefined,
  options: NativeMicrophoneOptions,
): Promise<MediaStreamTrack> {
  try {
    await track.applyConstraints(options);
  } catch (error) {
    console.warn('[voz] El navegador no pudo modificar la captura existente', error);
  }
  const actual = track.getSettings();
  const needsRecapture = (Object.keys(options) as Array<keyof NativeMicrophoneOptions>)
    .some(key => typeof actual[key] === 'boolean' && actual[key] !== options[key]);
  if (!needsRecapture) return track;
  // Some Chromium captures accept applyConstraints but silently retain the
  // original processing. Reacquire and replaceTrack avoids renegotiation.
  const replacement = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...options,
      ...(audioInputId ? { deviceId: { exact: audioInputId } } : {}),
    },
    video: false,
  });
  const next = replacement.getAudioTracks()[0];
  if (!next) {
    replacement.getTracks().forEach(item => item.stop());
    throw new Error('El navegador no devolvió un micrófono al actualizar los ajustes');
  }
  const nextSettings = next.getSettings();
  for (const key of Object.keys(options) as Array<keyof NativeMicrophoneOptions>) {
    if (typeof nextSettings[key] === 'boolean' && nextSettings[key] !== options[key]) {
      console.warn(`[voz] El navegador no admite ${key}=${options[key]} en este micrófono`);
    }
  }
  return next;
}

// RNNoise processes 480 samples (10 ms) at precisely 48 kHz. The browser
// resamples the captured track entering this context, and resamples its
// MediaStreamTrack again when a mixer with another sample rate consumes it.
export async function createMicrophoneProcessor(
  rawTrack: MediaStreamTrack,
  onFailure: (reason: string) => void,
): Promise<MicrophoneProcessor> {
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined'
      || typeof WebAssembly === 'undefined') {
    throw new Error('AudioWorklet o WebAssembly no disponible');
  }
  const context = new AudioContext({ sampleRate: 48000 });
  let node: RnnoiseWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let destination: MediaStreamAudioDestinationNode | undefined;
  let stopped = false;
  const restoreAfterBackground = () => {
    if (!stopped && document.visibilityState === 'visible' && context.state === 'suspended') {
      void context.resume().catch(error =>
        console.warn('[voz] No se pudo reanudar RNNoise tras volver a la llamada', error));
    }
  };
  document.addEventListener('visibilitychange', restoreAfterBackground);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('visibilitychange', restoreAfterBackground);
    source?.disconnect();
    try { node?.disconnect(); node?.destroy(); }
    catch (error) { console.warn('[voz] No se pudo liberar RNNoise', error); }
    destination?.stream.getTracks().forEach(track => track.stop());
    void context.close().catch(() => {});
  };
  try {
    if (!context.audioWorklet || context.sampleRate !== 48000) {
      throw new Error(`El contexto RNNoise requiere 48 kHz (recibidos: ${context.sampleRate} Hz)`);
    }
    // ?url makes all three assets part of the Vite bundle, not external CDN requests.
    const [binary] = await Promise.all([
      loadRnnoise({ url: wasmUrl, simdUrl: simdWasmUrl }),
      context.audioWorklet.addModule(workletUrl),
    ]);
    if (stopped) throw new Error('La llamada finalizó durante la carga de RNNoise');
    source = context.createMediaStreamSource(new MediaStream([rawTrack]));
    node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
    destination = context.createMediaStreamDestination();
    node.onprocessorerror = () => onFailure('El procesador RNNoise se detuvo inesperadamente');
    source.connect(node);
    node.connect(destination);
    await context.resume();
    // The worklet initializes WASM asynchronously. Keep the raw track live
    // while its first frames are prepared rather than switching to silence.
    await new Promise(resolve => setTimeout(resolve, 80));
    if (stopped) throw new Error('La llamada finalizó durante la carga de RNNoise');
    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('RNNoise no produjo una pista de audio');
    return { track, stop };
  } catch (error) {
    stop();
    throw error;
  }
}