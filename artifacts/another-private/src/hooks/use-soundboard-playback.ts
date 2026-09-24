import { useCallback, useEffect, useRef } from 'react';
import { useRealtimeMessages } from '@/providers/realtime-transport';
import { clampSoundVolume, createSoundContext } from '@/lib/voice-sounds';
import {
  isSoundboardPlayEvent,
  isSoundboardPlaybackClip,
  type SoundboardPlaybackClip,
} from '@/lib/soundboard-playback';

interface PlaybackSettings {
  volume: number;
  muted: boolean;
}

interface UseSoundboardPlaybackOptions {
  userId: number | undefined;
  settings: PlaybackSettings;
  activeVoiceChannelId: number | null;
  activeDmPeerId: number | null;
}

interface AudioCacheEntry {
  promise: Promise<AudioBuffer>;
}

const EVENT_TYPES = ['soundboard:play'] as const;
const MAX_CACHED_CLIPS = 24;

function withArtifactBaseUrl(url: string): string {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
  if (!base || base === '/' || !url.startsWith('/api/')) return url;
  if (url.startsWith(`${base}/`)) return url;
  return `${base}${url}`;
}

export function useSoundboardPlayback({
  userId,
  settings,
  activeVoiceChannelId,
  activeDmPeerId,
}: UseSoundboardPlaybackOptions): {
  playLocalClip: (clip: SoundboardPlaybackClip) => Promise<void>;
  preloadClips: (clips: readonly SoundboardPlaybackClip[]) => void;
} {
  const optionsRef = useRef({
    userId,
    settings,
    activeVoiceChannelId,
    activeDmPeerId,
  });
  optionsRef.current = { userId, settings, activeVoiceChannelId, activeDmPeerId };
  const callKey = userId && activeVoiceChannelId
    ? `${userId}:voice:${activeVoiceChannelId}`
    : userId && activeDmPeerId ? `${userId}:dm:${activeDmPeerId}` : null;
  const callKeyRef = useRef(callKey);
  callKeyRef.current = callKey;

  const audioContextRef = useRef<AudioContext | null>(null);
  const decodedAudioRef = useRef<Map<string, AudioCacheEntry>>(new Map());
  const activeSourcesRef = useRef(new Set<{ source: AudioBufferSourceNode; gain: GainNode }>());
  const aliveRef = useRef(true);

  const getAudioContext = useCallback((): AudioContext => {
    if (!audioContextRef.current) audioContextRef.current = createSoundContext();
    return audioContextRef.current;
  }, []);

  const getDecodedAudio = useCallback((url: string): Promise<AudioBuffer> => {
    const cache = decodedAudioRef.current;
    const cached = cache.get(url);
    if (cached) {
      cache.delete(url);
      cache.set(url, cached);
      return cached.promise;
    }

    const context = getAudioContext();
    let promise: Promise<AudioBuffer>;
    promise = (async () => {
      const response = await fetch(withArtifactBaseUrl(url), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Soundboard audio request failed (${response.status})`);
      const audioData = await response.arrayBuffer();
      const decoded = await context.decodeAudioData(audioData);
      if (!aliveRef.current) throw new Error('Soundboard playback has been disposed');
      return decoded;
    })().catch(error => {
      if (cache.get(url)?.promise === promise) cache.delete(url);
      throw error;
    });

    cache.set(url, { promise });
    while (cache.size > MAX_CACHED_CLIPS) {
      const oldestUrl = cache.keys().next().value as string | undefined;
      if (oldestUrl === undefined) break;
      cache.delete(oldestUrl);
    }
    return promise;
  }, [getAudioContext]);

  const preloadClips = useCallback((clips: readonly SoundboardPlaybackClip[]) => {
    for (const clip of clips) {
      if (!isSoundboardPlaybackClip(clip)) continue;
      void Promise.resolve()
        .then(() => getDecodedAudio(clip.url))
        .catch(error => console.warn('Soundboard clip preloading failed', error));
    }
  }, [getDecodedAudio]);

  const playAudio = useCallback(async (clip: SoundboardPlaybackClip) => {
    const current = optionsRef.current;
    const startedIn = callKeyRef.current;
    if (!startedIn || current.settings.muted || clampSoundVolume(current.settings.volume) === 0) return;
    if (!isSoundboardPlaybackClip(clip)) return;

    try {
      const context = getAudioContext();
      if (context.state === 'suspended') await context.resume();
      const buffer = await getDecodedAudio(clip.url);
      if (callKeyRef.current !== startedIn || optionsRef.current.settings.muted) return;

      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = clampSoundVolume(optionsRef.current.settings.volume);
      source.connect(gain);
      gain.connect(context.destination);
      const active = { source, gain };
      source.onended = () => {
        activeSourcesRef.current.delete(active);
        source.disconnect();
        gain.disconnect();
      };
      activeSourcesRef.current.add(active);
      source.start();
    } catch (error) {
      // Audio playback is optional and must not interfere with an active call.
      console.warn('Soundboard playback failed', error);
    }
  }, [getAudioContext, getDecodedAudio]);

  const playLocalClip = useCallback((clip: SoundboardPlaybackClip): Promise<void> => (
    playAudio(clip)
  ), [playAudio]);

  useRealtimeMessages(EVENT_TYPES, message => {
    const current = optionsRef.current;
    if (current.settings.muted || !isSoundboardPlayEvent(message)) return;
    const { data } = message;
    if (current.userId === undefined || data.triggeredById === current.userId) return;

    if (data.callType === 'voice') {
      if (current.activeVoiceChannelId !== data.channelId) return;
    } else if (current.activeDmPeerId !== data.triggeredById
      || current.userId !== data.peerId) {
      return;
    }

    void playAudio({
      id: data.clipId,
      serverId: data.serverId,
      url: data.url,
      name: data.name,
    });
  });

  useEffect(() => {
    const context = audioContextRef.current;
    const volume = settings.muted ? 0 : clampSoundVolume(settings.volume);
    for (const active of activeSourcesRef.current) {
      if (context) active.gain.gain.setValueAtTime(volume, context.currentTime);
      if (settings.muted) {
        try { active.source.stop(); } catch { /* Already ended. */ }
      }
    }
  }, [settings.muted, settings.volume]);

  useEffect(() => {
    for (const active of activeSourcesRef.current) {
      try { active.source.stop(); } catch { /* Already ended. */ }
    }
    activeSourcesRef.current.clear();
  }, [callKey]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      decodedAudioRef.current.clear();
      for (const active of activeSourcesRef.current) {
        try { active.source.stop(); } catch { /* Already ended. */ }
      }
      activeSourcesRef.current.clear();
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== 'closed') void context.close().catch(() => {});
    };
  }, []);

  return { playLocalClip, preloadClips };
}