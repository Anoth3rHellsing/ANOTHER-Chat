import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  getRemoteAudioPlaybackGraphForTest,
  RemoteAudioStreams,
} from '../src/components/remote-audio';
import type {
  CallAudioSource,
  PeerSourcePreferences,
  SourceLevel,
} from '../src/lib/call-source-preferences';
import '../src/index.css';

type AudioTracks = { microphone: MediaStreamTrack | null; screen: MediaStreamTrack | null };
type PeerSession = {
  sender: RTCPeerConnection;
  receiver: RTCPeerConnection;
  screenSender: RTCRtpSender;
  sources: Array<{ oscillator: OscillatorNode; destination: MediaStreamAudioDestinationNode }>;
};

declare global {
  interface Window {
    callSourceProbe?: {
      result: Promise<Record<string, unknown>>;
      peers: Map<number, PeerSession>;
      addPeer: (peerId: number, microphoneHz: number, screenHz: number) => Promise<void>;
      removePeer: (peerId: number) => void;
      hideVideoPanel: (hidden: boolean) => void;
      setLevel: (peerId: number, source: CallAudioSource, value: Partial<SourceLevel>) => void;
      rerender: () => void;
    };
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(read: () => T | null | undefined, label: string, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeTone(context: AudioContext, frequency: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.35;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  return { track: destination.stream.getAudioTracks()[0], oscillator, destination };
}

function Probe() {
  const [tracks, setTracks] = useState<Map<number, AudioTracks>>(new Map());
  const [preferences, setPreferences] = useState<Map<number, PeerSourcePreferences>>(new Map());
  const [videoPanelHidden, setVideoPanelHidden] = useState(false);
  const [, setTick] = useState(0);
  const contextRef = useRef<AudioContext | null>(null);
  if (!contextRef.current) contextRef.current = new AudioContext();
  const context = contextRef.current;
  const peersRef = useRef(new Map<number, PeerSession>());
  const peers = peersRef.current;

  const addPeer = async (peerId: number, microphoneHz: number, screenHz: number) => {
    const mic = makeTone(context, microphoneHz);
    const screen = makeTone(context, screenHz);
    const sender = new RTCPeerConnection({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    sender.addTrack(mic.track, new MediaStream([mic.track]));
    const screenSender = sender.addTrack(screen.track, new MediaStream([screen.track]));
    const session: PeerSession = {
      sender, receiver, screenSender,
      sources: [mic, screen].map(({ oscillator, destination }) => ({ oscillator, destination })),
    };
    peers.set(peerId, session);

    const received: Partial<AudioTracks> = {};
    receiver.ontrack = event => {
      const audioTransceivers = receiver.getTransceivers()
        .filter(transceiver => transceiver.receiver.track.kind === 'audio')
        .sort((a, b) => Number(a.mid) - Number(b.mid));
      const source: CallAudioSource = audioTransceivers.indexOf(event.transceiver) === 0
        ? 'microphone'
        : 'screen';
      received[source] = event.track;
      if (!received.microphone || !received.screen) return;
      const next = new Map((window.callSourceProbe as any).currentTracks as Map<number, AudioTracks>);
      next.set(peerId, { microphone: received.microphone, screen: received.screen });
      setTracks(next);
      (window.callSourceProbe as any).currentTracks = next;
    };

    sender.onicecandidate = event => {
      if (event.candidate) void receiver.addIceCandidate(event.candidate).catch(error => console.error(error));
    };
    receiver.onicecandidate = event => {
      if (event.candidate) void sender.addIceCandidate(event.candidate).catch(error => console.error(error));
    };
    await sender.setLocalDescription(await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription!);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription!);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (sender.connectionState !== 'connected' || receiver.connectionState !== 'connected')) {
      await sleep(50);
    }
    assert(sender.connectionState === 'connected' && receiver.connectionState === 'connected',
      `Synthetic peers did not connect (${sender.connectionState}/${receiver.connectionState})`);
    await waitFor(() => received.microphone && received.screen, `peer ${peerId} audio tracks`);
    setPreferences(prev => new Map(prev).set(peerId, {
      microphone: { volume: 1, muted: false },
      screen: { volume: 1, muted: false },
      cameraVisible: true,
      screenVisible: true,
    }));
  };

  const removePeer = (peerId: number) => {
    const session = peers.get(peerId);
    if (!session) return;
    session.sender.close();
    session.receiver.close();
    session.sources.forEach(({ oscillator, destination }) => {
      oscillator.stop();
      destination.stream.getTracks().forEach(track => track.stop());
    });
    peers.delete(peerId);
    setTracks(prev => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
    setPreferences(prev => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  };

  const setLevel = (peerId: number, source: CallAudioSource, value: Partial<SourceLevel>) => {
    setPreferences(prev => {
      const next = new Map(prev);
      const prior = next.get(peerId) ?? {
        microphone: { volume: 1, muted: false },
        screen: { volume: 1, muted: false },
        cameraVisible: true,
        screenVisible: true,
      };
      next.set(peerId, { ...prior, [source]: { ...prior[source], ...value } });
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const result: Record<string, unknown> = {};
      const meters = new Map<HTMLAudioElement, AnalyserNode>();
      try {
        if (context.state === 'suspended') {
          // Under the default autoplay policy the test oscillator needs a real
          // gesture too; otherwise its pending resume would block the fixture.
          const resumeOnGesture = () => { void context.resume(); };
          window.addEventListener('pointerdown', resumeOnGesture);
          try {
            await context.resume();
          } finally {
            window.removeEventListener('pointerdown', resumeOnGesture);
          }
        }
        await addPeer(11, 440, 880);
        await addPeer(22, 330, 660);
        const probe = window.callSourceProbe!;
        const audioElements = () => [...document.querySelectorAll<HTMLAudioElement>('audio[data-remote-audio-peer]')];
        await waitFor(() => audioElements().length === 4 ? true : null, 'four source-specific audio elements');
        const mic11 = '11:microphone';
        const screen11 = '11:screen';
        const mic22 = '22:microphone';
        const screen22 = '22:screen';
        const fixedElements = new Map(audioElements().map(audio => [
          `${audio.dataset.remoteAudioPeer}:${audio.dataset.remoteAudioSource}`, audio,
        ]));
        const trackIds = new Map([...fixedElements].map(([key, element]) => [
          key, [...((element.srcObject as MediaStream | null)?.getAudioTracks() ?? [])].map(track => track.id).join(','),
        ]));
        const initialSourceObjects = new Map([...fixedElements].map(([key, audio]) => [key, audio.srcObject]));
        const initialPlayCalls = new Map([...fixedElements].map(([key, audio]) =>
          [key, (audio as any).__playCalls ?? 0]));
        for (const audio of fixedElements.values()) {
          const graph = getRemoteAudioPlaybackGraphForTest(audio);
          assert(graph, `No playback graph for ${audio.dataset.remoteAudioPeer}:${audio.dataset.remoteAudioSource}`);
          assert(graph.stream === audio.srcObject && graph.stream.getAudioTracks().length === 1,
            `Playback graph does not use the persistent single-track stream for ${audio.dataset.remoteAudioPeer}:${audio.dataset.remoteAudioSource}`);
          const analyser = graph.gain.context.createAnalyser();
          analyser.fftSize = 16384;
          analyser.smoothingTimeConstant = 0;
          graph.gain.connect(analyser);
          meters.set(audio, analyser);
        }
        await waitFor(() => [...fixedElements.values()].every(audio => !audio.paused &&
          (audio.srcObject as MediaStream | null)?.getAudioTracks().length === 1), 'playing isolated remote tracks');
        const frequencyHz: Record<string, number> = {
          [mic11]: 440,
          [screen11]: 880,
          [mic22]: 330,
          [screen22]: 660,
        };
        const peakDb = (key: string) => {
          const analyser = meters.get(fixedElements.get(key)!);
          if (!analyser) throw new Error(`Missing analyser for ${key}`);
          const values = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(values);
          const center = Math.round(frequencyHz[key] / (analyser.context.sampleRate / analyser.fftSize));
          let peak = -Infinity;
          for (let index = center - 2; index <= center + 2; index++) peak = Math.max(peak, values[index]);
          return Number.isFinite(peak) ? peak : -120;
        };
        const sample = async (key: string) => {
          const readings: number[] = [];
          for (let index = 0; index < 5; index++) {
            readings.push(peakDb(key));
            await sleep(120);
          }
          return readings.reduce((sum, reading) => sum + reading, 0) / readings.length;
        };
        const waitForLevel = async (key: string, predicate: (value: number) => boolean, label: string) => {
          const deadline = Date.now() + 6000;
          let last = 0;
          while (Date.now() < deadline) {
            last = await sample(key);
            if (predicate(last)) return last;
          }
          throw new Error(`${label}: measured post-gain output ${last} dBFS`);
        };

        const initialScreen11 = await waitForLevel(screen11, value => value > -28, 'initial screen 11 tone');
        const initialMic11 = await waitForLevel(mic11, value => value > -28, 'initial mic 11 tone');
        const initialScreen22 = await waitForLevel(screen22, value => value > -28, 'initial screen 22 tone');
        result.initialPostGainOutputDb = { mic11: initialMic11, screen11: initialScreen11, screen22: initialScreen22 };

        probe.setLevel(11, 'screen', { volume: 0.25, muted: false });
        const screenQuarterOutput = await waitForLevel(screen11,
          value => value < initialScreen11 - 8, 'screen 11 quarter-volume output');
        const unchangedMic = await sample(mic11);
        assert(Math.abs(unchangedMic - initialMic11) < 3,
          `Lowering screen gain changed microphone output (${initialMic11} -> ${unchangedMic} dBFS)`);
        assert(screenQuarterOutput > initialScreen11 - 16,
          `Screen quarter-volume output was outside the expected attenuation: ${screenQuarterOutput} dBFS`);
        result.screenQuarterVolumeOutputDb = screenQuarterOutput;
        result.micOutputAfterScreenVolumeChangeDb = unchangedMic;

        probe.setLevel(11, 'screen', { muted: true });
        const mutedScreenOutput = await waitForLevel(screen11, value => value < -65,
          'screen 11 output mute');
        const micAfterScreenMute = await sample(mic11);
        assert(Math.abs(micAfterScreenMute - initialMic11) < 3,
          `Muting screen 11 muted its microphone output (${micAfterScreenMute} dBFS)`);
        result.screenMutedOutputDb = mutedScreenOutput;
        result.micOutputDuringScreenMuteDb = micAfterScreenMute;

        probe.setLevel(11, 'microphone', { muted: true });
        const mutedMicOutput = await waitForLevel(mic11, value => value < -65, 'microphone 11 output mute');
        probe.setLevel(11, 'screen', { muted: false, volume: 0.25 });
        const screenWithMicMuted = await waitForLevel(screen11,
          value => value > initialScreen11 - 16 && value < initialScreen11 - 8,
          'quarter-volume screen output while microphone is muted');
        result.micMutedOutputDb = mutedMicOutput;
        result.screenOutputWhileMicMutedDb = screenWithMicMuted;

        probe.setLevel(11, 'microphone', { muted: false });
        const restoredMicOutput = await waitForLevel(mic11, value => value > initialMic11 - 3,
          'microphone 11 restored');
        probe.setLevel(11, 'screen', { volume: 1, muted: false });
        const restoredScreenOutput = await waitForLevel(screen11, value => value > initialScreen11 - 3,
          'screen 11 restored');
        result.restoredPostGainOutputDb = { microphone: restoredMicOutput, screen: restoredScreenOutput };

        for (const [key, element] of fixedElements) {
          assert(element.srcObject === initialSourceObjects.get(key), `Audio source ${key} changed with preferences`);
          assert((element as any).__playCalls === initialPlayCalls.get(key), `Audio ${key} replayed with preferences`);
          assert(!element.paused, `Audio ${key} paused while applying preferences`);
        }
        const beforeRerenderSources = initialSourceObjects;
        const beforePlayCalls = initialPlayCalls;
        const beforeValues = new Map([...fixedElements].map(([key, element]) =>
          [key, { volume: element.volume, muted: element.muted }]));
        probe.hideVideoPanel(true);
        probe.rerender();
        await sleep(250);
        for (const [key, element] of fixedElements) {
          assert(audioElements().find(candidate => `${candidate.dataset.remoteAudioPeer}:${candidate.dataset.remoteAudioSource}` === key) === element,
            `Audio DOM element ${key} was replaced by an unrelated render`);
          assert(element.srcObject === beforeRerenderSources.get(key), `Audio source ${key} was reassigned on render`);
          assert(!element.paused, `Audio ${key} paused when visual content was hidden`);
          assert((element as any).__playCalls === beforePlayCalls.get(key), `Audio ${key} replayed on render`);
          const pref = beforeValues.get(key)!;
          assert(element.volume === pref.volume && element.muted === pref.muted, `Audio setting ${key} changed on rerender`);
        }
        assert(document.getElementById('video-panel')!.classList.contains('hidden'),
          'Synthetic video panel did not hide');
        result.persistentAfterHiddenPanel = true;

        const peer11ScreenTrackId = trackIds.get(screen11);
        assert((fixedElements.get(screen11)!.srcObject as MediaStream).getAudioTracks()[0].id === peer11ScreenTrackId,
          'Screen source element does not contain only its assigned screen track');
        const peer22ScreenTrackId = trackIds.get(screen22);
        assert((fixedElements.get(screen22)!.srcObject as MediaStream).getAudioTracks()[0].id === peer22ScreenTrackId,
          'Second participant screen source element does not contain only its screen track');

        await probe.addPeer(33, 220, 1320);
        await waitFor(() => audioElements().length === 6 ? true : null, 'new participant source elements');
        for (const [key, element] of fixedElements) {
          assert(audioElements().includes(element) && !element.paused && element.srcObject === beforeRerenderSources.get(key),
            `Existing audio element ${key} changed when another participant joined`);
        }
        const secondScreenWhileBothPeersActive = await sample(screen22);
        probe.removePeer(22);
        await waitFor(() => audioElements().length === 4 ? true : null, 'departing participant teardown');
        for (const [key, element] of fixedElements) {
          if (key.startsWith('11:')) {
            assert(audioElements().includes(element) && !element.paused &&
              element.srcObject === beforeRerenderSources.get(key),
            `Peer 11 source ${key} was interrupted when peer 22 left`);
          }
        }
        result.concurrentScreenPostGainOutputDb = {
          firstScreen: restoredScreenOutput,
          secondScreenBeforeLeaving: secondScreenWhileBothPeersActive,
        };
        assert(fixedElements.get(screen11) !== fixedElements.get(screen22),
          'Two screen audio tracks do not have separate stable elements');
        result.stableElementsBySource = fixedElements.size;

        // Chromium may leave the receiver track live *and unmuted* when its
        // sender uses replaceTrack(null); verify actual output, not track.muted.
        const peer11 = peers.get(11)!;
        const screenTrack = (fixedElements.get(screen11)!.srcObject as MediaStream).getAudioTracks()[0];
        await peer11.screenSender.replaceTrack(null);
        const stoppedScreenOutput = await waitForLevel(screen11, value => value < -65,
          'screen output stopped after replaceTrack(null)');
        const micWhileStopped = await sample(mic11);
        assert(Math.abs(micWhileStopped - restoredMicOutput) < 3,
          'Stopping a screen audio sender affected the microphone output');
        assert(!fixedElements.get(screen11)!.paused && !fixedElements.get(mic11)!.paused,
          'Stopping the screen sender must not pause either persistent audio element');
        result.screenStoppedOutputDb = stoppedScreenOutput;
        result.receiverTrackMutedAfterStop = screenTrack.muted;
        await peer11.screenSender.replaceTrack(peer11.sources[1].destination.stream.getAudioTracks()[0]);
        result.screenRestartedOutputDb = await waitForLevel(screen11,
          value => value > initialScreen11 - 3, 'screen output restored after re-share');

        if (!cancelled) (window as any).callSourceAudioResult = { status: 'passed', results: result };
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        if (!cancelled) (window as any).callSourceAudioResult = { status: 'failed', results: result };
      }
    };
    (window as any).callSourceProbe = {
      result: run(),
      peers,
      currentTracks: tracks,
      addPeer,
      removePeer,
      hideVideoPanel: (hidden: boolean) => setVideoPanelHidden(hidden),
      setLevel,
      rerender: () => setTick(tick => tick + 1),
    };
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      (this as any).__playCalls = ((this as any).__playCalls ?? 0) + 1;
      return realPlay.call(this);
    };
    return () => {
      cancelled = true;
      peers.forEach(session => {
        session.sender.close();
        session.receiver.close();
        session.sources.forEach(({ oscillator, destination }) => {
          oscillator.stop();
          destination.stream.getTracks().forEach(track => track.stop());
        });
      });
      void context.close();
    };
    // The probe intentionally creates one stable AudioContext per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div id="video-panel" className={videoPanelHidden ? 'hidden' : ''}>
        Synthetic remote video panels may be hidden without unmounting audio.
      </div>
      <RemoteAudioStreams tracks={tracks} preferences={preferences} />
    </>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Probe />);
(window as any).unmountSourceProbe = () => root.unmount();