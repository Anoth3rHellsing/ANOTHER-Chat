import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { VideoOff } from 'lucide-react';
import { sourcePreferencesFor, type CallAudioSource, type PeerSourcePreferences } from '@/lib/call-source-preferences';

type RemoteAudioSourceTracks = {
  microphone: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
};

type RemoteAudioPreferences = Pick<PeerSourcePreferences, 'microphone' | 'screen'>;

export interface RemoteAudioPlaybackGraph {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  disconnect: () => void;
}

const outputGraphs = new WeakMap<HTMLAudioElement, RemoteAudioPlaybackGraph>();
let sharedPlaybackContext: AudioContext | null = null;

function getPlaybackContext(): AudioContext {
  if (!sharedPlaybackContext || sharedPlaybackContext.state === 'closed') {
    sharedPlaybackContext = new AudioContext();
  }
  return sharedPlaybackContext;
}

export function createRemoteAudioPlaybackGraph(
  track: MediaStreamTrack,
  context: AudioContext,
  destination: AudioNode = context.destination,
): RemoteAudioPlaybackGraph {
  const stream = new MediaStream([track]);
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  source.connect(gain);
  gain.connect(destination);
  return {
    stream,
    source,
    gain,
    disconnect: () => {
      source.disconnect();
      gain.disconnect();
    },
  };
}

/** Allows the focused browser regression to meter the component's actual post-gain signal. */
export function getRemoteAudioPlaybackGraphForTest(audio: HTMLAudioElement): RemoteAudioPlaybackGraph | null {
  return outputGraphs.get(audio) ?? null;
}

function RemoteAudio({
  peerId,
  source,
  track,
  preferences,
}: {
  peerId: number;
  source: CallAudioSource;
  track: MediaStreamTrack | null;
  preferences: RemoteAudioPreferences;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const currentTrackRef = useRef<MediaStreamTrack | null>(null);
  const graphRef = useRef<RemoteAudioPlaybackGraph | null>(null);
  const retryCleanupRef = useRef<() => void>(() => undefined);
  const preference = preferences[source];

  useLayoutEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    retryCleanupRef.current();
    if (currentTrackRef.current === track) return;
    graphRef.current?.disconnect();
    graphRef.current = null;
    if (track) {
      const context = getPlaybackContext();
      graphRef.current = createRemoteAudioPlaybackGraph(track, context);
      outputGraphs.set(audio, graphRef.current);
    } else {
      outputGraphs.delete(audio);
    }
    currentTrackRef.current = track;
    audio.srcObject = graphRef.current?.stream ?? null;
    audio.muted = true;
    if (!track) {
      audio.pause();
      return;
    }

    let disposed = false;
    let retryPending = false;
    const context = graphRef.current?.gain.context as AudioContext | undefined;
    const removeRetryListeners = () => {
      retryPending = false;
      window.removeEventListener('pointerdown', attemptPlay);
      window.removeEventListener('keydown', attemptPlay);
    };
    const enableRetry = () => {
      if (retryPending || disposed) return;
      retryPending = true;
      window.addEventListener('pointerdown', attemptPlay);
      window.addEventListener('keydown', attemptPlay);
    };
    const onContextStateChange = () => {
      if (context?.state === 'running' && !audio.paused) removeRetryListeners();
      else enableRetry();
    };
    const attemptPlay = () => {
      if (disposed) return;
      // A muted media element may play while Web Audio remains suspended. Register
      // the gesture retry *before* resume(): its promise may stay pending until a gesture.
      if (context?.state !== 'running') enableRetry();
      const resumeContext = context?.state === 'suspended' ? context.resume() : Promise.resolve();
      void Promise.all([audio.play(), resumeContext]).then(() => {
        if (disposed) return;
        if (context?.state === 'running' && !audio.paused) {
          if (retryPending) console.info(`[voz][par ${peerId}] Reproducción remota reanudada`);
          removeRetryListeners();
        } else enableRetry();
      }).catch(error => {
        if (disposed) return;
        if (!retryPending) {
          console.warn(`[voz][par ${peerId}] Autoplay bloqueado; se reintentará tras una interacción`, error);
        }
        enableRetry();
      });
    };
    const onPlaying = () => {
      if (context?.state === 'running') removeRetryListeners();
      else enableRetry();
    };
    const cleanup = () => {
      disposed = true;
      removeRetryListeners();
      audio.removeEventListener('playing', onPlaying);
      context?.removeEventListener('statechange', onContextStateChange);
    };
    retryCleanupRef.current = cleanup;
    audio.addEventListener('playing', onPlaying);
    context?.addEventListener('statechange', onContextStateChange);
    attemptPlay();
  }, [peerId, track]);

  useLayoutEffect(() => {
    const gain = graphRef.current?.gain;
    if (!gain) return;
    const effectiveLevel = preference.muted ? 0 : Math.max(0, Math.min(1, preference.volume));
    gain.gain.setTargetAtTime(effectiveLevel, gain.context.currentTime, 0.015);
  }, [preference.volume, preference.muted, track]);

  useLayoutEffect(() => () => {
    retryCleanupRef.current();
    const audio = audioRef.current;
    audio?.pause();
    if (audio) audio.srcObject = null;
    if (audio) outputGraphs.delete(audio);
    currentTrackRef.current = null;
    graphRef.current?.disconnect();
    graphRef.current = null;
  }, []);

  return (
    <audio
      ref={audioRef}
      autoPlay
      muted
      data-remote-audio-peer={peerId}
      data-remote-audio-source={source}
      data-remote-audio-track={track?.id ?? ''}
      aria-hidden="true"
    />
  );
}

export function RemoteAudioStreams({
  tracks,
  preferences,
}: {
  tracks: Map<number, RemoteAudioSourceTracks>;
  preferences: ReadonlyMap<number, PeerSourcePreferences>;
}) {
  return (
    <>
      {[...tracks].flatMap(([peerId, sources]) => {
        const peerPreferences = sourcePreferencesFor(preferences, peerId);
        return (['microphone', 'screen'] as const).map(source => (
          <RemoteAudio
            key={`${peerId}:${source}`}
            peerId={peerId}
            source={source}
            track={sources[source]}
            preferences={peerPreferences}
          />
        ));
      })}
    </>
  );
}

export function RemoteVideo({ stream, fit = 'cover' }: { stream: MediaStream; fit?: 'cover' | 'contain' }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    const update = () => setHasVideo(stream.getVideoTracks().some(track =>
      track.readyState === 'live' && !track.muted
    ));
    let tracks: MediaStreamTrack[] = [];
    const refreshTracks = () => {
      tracks.forEach(track => {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      });
      tracks = stream.getVideoTracks();
      tracks.forEach(track => {
        track.addEventListener('mute', update);
        track.addEventListener('unmute', update);
        track.addEventListener('ended', update);
      });
      update();
    };
    stream.addEventListener('addtrack', refreshTracks);
    stream.addEventListener('removetrack', refreshTracks);
    refreshTracks();
    return () => {
      stream.removeEventListener('addtrack', refreshTracks);
      stream.removeEventListener('removetrack', refreshTracks);
      tracks.forEach(track => {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      });
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <div className="relative h-full w-full">
      <video ref={videoRef} autoPlay muted playsInline
        className={`h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} ${hasVideo ? '' : 'invisible'}`} />
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-secondary text-muted-foreground">
          <VideoOff className="h-9 w-9" aria-label="Cámara apagada" />
        </div>
      )}
    </div>
  );
}