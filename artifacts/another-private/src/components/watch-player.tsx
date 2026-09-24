import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Music2, Pause, Play, RotateCw, Volume2, VolumeX } from 'lucide-react';
import {
  clampWatchVolume,
  expectedWatchPosition,
  shouldCorrectWatchDrift,
  toSoundCloudWidgetVolume,
  toYouTubePlayerVolume,
  type WatchItem,
  type WatchPlatform,
  type WatchSessionState,
} from '@/lib/watch-session';

interface WatchPlayerProps {
  current: WatchItem | null;
  playing: boolean;
  positionMs: number;
  updatedAtMs: number;
  durationMs?: number;
  localVolume: number;
  muted?: boolean;
  canControl: boolean;
  sessionKey: string;
  onVolumeChange: (volume: number) => void;
  onPlay: () => void;
  onPause: (positionMs: number) => void;
  onSeek: (positionMs: number) => void;
  onEnded: () => void;
  onMetadata: (metadata: { title: string; durationMs?: number }) => void;
  onLoadError?: (message: string | null) => void;
}

interface YouTubePlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  loadVideoById: (videoId: string | { videoId: string; startSeconds?: number }) => void;
  cueVideoById: (videoId: string | { videoId: string; startSeconds?: number }) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  isMuted: () => boolean;
  setVolume: (volume: number) => void;
  mute: () => void;
  unMute: () => void;
  getVideoData: () => { title?: string };
  destroy: () => void;
}

interface YouTubeEvent {
  data: number;
  target: YouTubePlayer;
}

interface YouTubeApi {
  Player: new (element: HTMLElement, options: {
    width: string;
    height: string;
    videoId?: string;
    playerVars: Record<string, string | number>;
    events: {
      onReady: (event: YouTubeEvent) => void;
      onStateChange: (event: YouTubeEvent) => void;
      onError: (event: YouTubeEvent) => void;
      onAutoplayBlocked: () => void;
    };
  }) => YouTubePlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
}

interface YouTubeWindow extends Window {
  YT?: YouTubeApi;
  onYouTubeIframeAPIReady?: () => void;
}

interface SoundCloudSound {
  title?: string;
  duration?: number;
}

interface SoundCloudWidget {
  bind: (event: string, listener: (event?: unknown) => void) => void;
  unbind: (event: string) => void;
  load: (url: string, options?: Record<string, unknown>) => void;
  play: () => void;
  pause: () => void;
  seekTo: (positionMs: number) => void;
  setVolume: (volume: number) => void;
  getVolume: (callback: (volume: number) => void) => void;
  getPosition: (callback: (positionMs: number) => void) => void;
  getDuration: (callback: (durationMs: number) => void) => void;
  getCurrentSound: (callback: (sound: SoundCloudSound | null) => void) => void;
  isPaused: (callback: (paused: boolean) => void) => void;
}

interface SoundCloudApi {
  Widget: {
    (iframe: HTMLIFrameElement): SoundCloudWidget;
    Events: Record<string, string>;
  };
}

interface SoundCloudWindow extends Window {
  SC?: SoundCloudApi;
}

let youtubeApiPromise: Promise<YouTubeApi> | null = null;
let soundCloudApiPromise: Promise<SoundCloudApi> | null = null;

function loadPlayerApi(platform: WatchPlatform): Promise<YouTubeApi | SoundCloudApi> {
  const windowWithApi = window as YouTubeWindow & SoundCloudWindow;
  if (platform === 'youtube') {
    if (windowWithApi.YT?.Player) return Promise.resolve(windowWithApi.YT);
    if (youtubeApiPromise) return youtubeApiPromise;
    youtubeApiPromise = new Promise<YouTubeApi>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-watch-youtube-api="true"]');
      const script = existing ?? document.createElement('script');
      const timeout = window.setTimeout(() => reject(new Error('La API oficial de YouTube tardó demasiado en cargar.')), 15000);
      const previousCallback = windowWithApi.onYouTubeIframeAPIReady;
      windowWithApi.onYouTubeIframeAPIReady = () => {
        previousCallback?.();
        window.clearTimeout(timeout);
        if (windowWithApi.YT?.Player) resolve(windowWithApi.YT);
        else reject(new Error('YouTube no pudo inicializar su reproductor.'));
      };
      if (!existing) {
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        script.dataset.watchYoutubeApi = 'true';
        script.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('No se pudo cargar la API oficial de YouTube.'));
        };
        document.head.appendChild(script);
      }
    }).catch(error => {
      youtubeApiPromise = null;
      throw error;
    });
    return youtubeApiPromise;
  }

  if (windowWithApi.SC?.Widget) return Promise.resolve(windowWithApi.SC);
  if (soundCloudApiPromise) return soundCloudApiPromise;
  soundCloudApiPromise = new Promise<SoundCloudApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-watch-soundcloud-api="true"]');
    const script = existing ?? document.createElement('script');
    const timeout = window.setTimeout(() => reject(new Error('La API oficial de SoundCloud tardó demasiado en cargar.')), 15000);
    const checkReady = () => {
      if (!windowWithApi.SC?.Widget) return false;
      window.clearTimeout(timeout);
      resolve(windowWithApi.SC);
      return true;
    };
    const poll = window.setInterval(() => {
      if (checkReady()) window.clearInterval(poll);
    }, 50);
    window.setTimeout(() => window.clearInterval(poll), 15000);
    if (!existing) {
      script.src = 'https://w.soundcloud.com/player/api.js';
      script.async = true;
      script.dataset.watchSoundcloudApi = 'true';
      script.onerror = () => {
        window.clearTimeout(timeout);
        window.clearInterval(poll);
        reject(new Error('No se pudo cargar la API oficial de SoundCloud.'));
      };
      script.onload = () => { checkReady(); };
      document.head.appendChild(script);
    }
  }).catch(error => {
    soundCloudApiPromise = null;
    throw error;
  });
  return soundCloudApiPromise;
}

function platformError(platform: WatchPlatform, code: number): string {
  if (platform === 'youtube') {
    if (code === 2) return 'YouTube rechazó el identificador del vídeo.';
    if (code === 5) return 'Este vídeo no se puede reproducir en el reproductor incrustado.';
    if (code === 100) return 'El vídeo no está disponible, es privado o fue retirado.';
    if (code === 101 || code === 150) return 'El autor de este vídeo no permite reproducirlo aquí.';
    if (code === 153) return 'YouTube no pudo comprobar el origen del reproductor. Recarga la página e inténtalo de nuevo.';
    return 'YouTube no pudo cargar este vídeo en tu región o dispositivo.';
  }
  return 'SoundCloud no pudo cargar esta pista. Puede ser privada, no estar disponible en tu región o no permitir reproducción incrustada.';
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function sessionSnapshot(props: WatchPlayerProps): WatchSessionState {
  return {
    controllerUserId: 1,
    allowEveryone: true,
    current: props.current,
    queue: [],
    playing: props.playing,
    positionMs: props.positionMs,
    updatedAtMs: props.updatedAtMs,
    serverNowMs: props.updatedAtMs,
    revision: 0,
  };
}

export function WatchPlayer({
  current,
  playing,
  positionMs,
  updatedAtMs,
  durationMs,
  localVolume,
  muted = false,
  canControl,
  sessionKey,
  onVolumeChange,
  onPlay,
  onPause,
  onSeek,
  onEnded,
  onMetadata,
  onLoadError,
}: WatchPlayerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const soundCloudFrameRef = useRef<HTMLIFrameElement>(null);
  const youtubePlayerRef = useRef<YouTubePlayer | null>(null);
  const soundCloudWidgetRef = useRef<SoundCloudWidget | null>(null);
  const currentRef = useRef({ current, playing, positionMs, updatedAtMs, durationMs });
  currentRef.current = { current, playing, positionMs, updatedAtMs, durationMs };
  const propsRef = useRef({ canControl, onPlay, onPause, onSeek, onEnded, onMetadata, onLoadError });
  propsRef.current = { canControl, onPlay, onPause, onSeek, onEnded, onMetadata, onLoadError };
  const [playerReady, setPlayerReady] = useState(false);
  const playerReadyRef = useRef(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [currentPositionMs, setCurrentPositionMs] = useState(positionMs);
  const currentPositionRef = useRef(currentPositionMs);
  currentPositionRef.current = currentPositionMs;
  const [duration, setDuration] = useState(durationMs ?? current?.durationMs ?? 0);
  const [seekPreviewMs, setSeekPreviewMs] = useState<number | null>(null);
  const itemKey = current ? `${current.platform}:${current.contentId}:${current.id}` : '';
  const lastLoadedKeyRef = useRef('');
  const endedKeyRef = useRef('');
  const programmaticSoundCloudCommandRef = useRef(false);
  const audioActivatedRef = useRef(false);
  const localVolumeRef = useRef({ localVolume, muted });
  localVolumeRef.current = { localVolume, muted };

  const setError = useCallback((message: string) => {
    setPlayerError(message);
    setPlaybackBlocked(false);
    propsRef.current.onLoadError?.(message);
  }, []);

  const clearError = useCallback(() => {
    setPlayerError(null);
    setPlaybackBlocked(false);
    propsRef.current.onLoadError?.(null);
  }, []);

  const applyLocalVolume = useCallback(() => {
    const latest = localVolumeRef.current;
    const normalized = latest.muted ? 0 : clampWatchVolume(latest.localVolume);
    const player = youtubePlayerRef.current;
    if (player) {
      player.setVolume(toYouTubePlayerVolume(normalized));
      if (normalized === 0) player.mute();
      else player.unMute();
    }
    soundCloudWidgetRef.current?.setVolume(toSoundCloudWidgetVolume(normalized));
  }, []);

  const confirmSoundCloudVolume = useCallback((widget: SoundCloudWidget) => {
    widget.getVolume(actual => {
      if (widget !== soundCloudWidgetRef.current) return;
      const { localVolume: requested, muted: isMuted } = localVolumeRef.current;
      const desired = toSoundCloudWidgetVolume(isMuted ? 0 : requested);
      if (Number.isFinite(actual) && Math.round(actual) !== desired) {
        // Loading a new widget can reset its own volume independently of the
        // user's local preference. Never change it in the seek/drift path.
        widget.setVolume(desired);
        widget.getVolume(confirmed => {
          if (widget !== soundCloudWidgetRef.current || Math.round(confirmed) === desired) return;
          setPlaybackBlocked(true);
          setPlayerError('SoundCloud no confirmó el volumen local. Pulsa Reproducir en este dispositivo.');
        });
      }
    });
  }, []);

  const getExpectedPosition = useCallback(() => {
    const snapshot = sessionSnapshot(currentRef.current as WatchPlayerProps);
    return expectedWatchPosition(snapshot, Date.now());
  }, []);

  const currentTime = useCallback((): number => {
    try {
      if (currentRef.current.current?.platform === 'youtube' && youtubePlayerRef.current) {
        return Math.max(0, Math.round(youtubePlayerRef.current.getCurrentTime() * 1000));
      }
    } catch {
      // Player may still be initializing or may have become unavailable.
    }
    return currentPositionRef.current;
  }, []);

  const seekLocal = useCallback((position: number) => {
    const safePosition = Math.max(0, Math.floor(position));
    setCurrentPositionMs(safePosition);
    if (currentRef.current.current?.platform === 'youtube' && youtubePlayerRef.current) {
      youtubePlayerRef.current.seekTo(safePosition / 1000, true);
    } else if (currentRef.current.current?.platform === 'soundcloud' && soundCloudWidgetRef.current) {
      soundCloudWidgetRef.current.seekTo(safePosition);
    }
  }, []);

  const playLocal = useCallback((fromUserGesture = false) => {
    if (fromUserGesture) audioActivatedRef.current = true;
    setPlaybackBlocked(false);
    setPlayerError(null);
    if (currentRef.current.current?.platform === 'youtube' && youtubePlayerRef.current) {
      youtubePlayerRef.current.playVideo();
      return;
    }
    const widget = soundCloudWidgetRef.current;
    if (widget) {
      programmaticSoundCloudCommandRef.current = true;
      widget.play();
      window.setTimeout(() => { programmaticSoundCloudCommandRef.current = false; }, 1200);
      window.setTimeout(() => {
        if (widget !== soundCloudWidgetRef.current || !currentRef.current.playing) return;
        confirmSoundCloudVolume(widget);
        widget.isPaused(paused => {
          if (widget !== soundCloudWidgetRef.current || !currentRef.current.playing) return;
          if (paused) {
            setPlaybackBlocked(true);
            setPlayerError('Tu navegador requiere que pulses Reproducir para activar el contenido.');
          } else if (!fromUserGesture && !audioActivatedRef.current) {
            // The widget can advance while the browser suppresses audio. Its
            // getVolume() reports its slider, not the browser's audio output.
            setPlaybackBlocked(true);
            setPlayerError('Si la pista avanza sin sonido, pulsa Reproducir en este dispositivo para activar el audio.');
          }
        });
      }, 1200);
    }
  }, [confirmSoundCloudVolume]);

  const pauseLocal = useCallback(() => {
    if (currentRef.current.current?.platform === 'youtube' && youtubePlayerRef.current) {
      youtubePlayerRef.current.pauseVideo();
      return;
    }
    soundCloudWidgetRef.current?.pause();
  }, []);

  useEffect(() => {
    endedKeyRef.current = '';
    setCurrentPositionMs(currentRef.current.positionMs);
    setSeekPreviewMs(null);
    setDuration(currentRef.current.durationMs ?? currentRef.current.current?.durationMs ?? 0);
  }, [itemKey]);

  useEffect(() => {
    if (!current) return undefined;
    setPlayerReady(false);
    playerReadyRef.current = false;
    setPlayerError(null);
    setPlaybackBlocked(false);
    let disposed = false;
    let timer: number | undefined;
    let teardownSoundCloud: (() => void) | undefined;

    if (current.platform === 'youtube') {
      loadPlayerApi('youtube').then(api => {
        if (disposed || !mountRef.current) return;
        const youtube = api as YouTubeApi;
        const expected = Math.max(0, expectedWatchPosition(sessionSnapshot(currentRef.current as WatchPlayerProps), Date.now()));
        youtubePlayerRef.current = new youtube.Player(mountRef.current, {
          width: '480',
          height: '270',
          videoId: current.contentId,
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            enablejsapi: 1,
            fs: 1,
            playsinline: 1,
            rel: 0,
            start: Math.floor(expected / 1000),
            origin: window.location.origin,
          },
          events: {
            onReady: event => {
              if (disposed) return;
              clearError();
              lastLoadedKeyRef.current = itemKey;
              playerReadyRef.current = true;
              setPlayerReady(true);
              applyLocalVolume();
              const latest = currentRef.current;
              const position = expectedWatchPosition(sessionSnapshot(latest as WatchPlayerProps), Date.now());
              if (latest.playing) {
                event.target.seekTo(position / 1000, true);
                playLocal();
              } else {
                event.target.seekTo(position / 1000, true);
                event.target.pauseVideo();
              }
              const title = event.target.getVideoData()?.title;
              const durationValue = Math.round(event.target.getDuration() * 1000);
              if (title || durationValue > 0) {
                propsRef.current.onMetadata({
                  title: title ?? current.title,
                  ...(durationValue > 0 ? { durationMs: durationValue } : {}),
                });
                if (durationValue > 0) setDuration(durationValue);
              }
            },
            onStateChange: event => {
              if (disposed) return;
              if (event.data === youtube.PlayerState.ENDED && propsRef.current.canControl
                && endedKeyRef.current !== current.id) {
                endedKeyRef.current = current.id;
                propsRef.current.onEnded();
              }
              if (event.data === youtube.PlayerState.PLAYING) {
                if (localVolumeRef.current.localVolume > 0 && !localVolumeRef.current.muted
                  && event.target.isMuted()) {
                  setPlaybackBlocked(true);
                  setPlayerError('YouTube está silenciado. Pulsa Reproducir en este dispositivo para activar el audio.');
                } else if (!audioActivatedRef.current && localVolumeRef.current.localVolume > 0
                  && !localVolumeRef.current.muted) {
                  setPlaybackBlocked(true);
                  setPlayerError('Si el vídeo avanza sin sonido, pulsa Reproducir en este dispositivo para activar el audio.');
                }
                const title = event.target.getVideoData()?.title;
                const durationValue = Math.round(event.target.getDuration() * 1000);
                if (title || durationValue > 0) {
                  propsRef.current.onMetadata({
                    title: title ?? current.title,
                    ...(durationValue > 0 ? { durationMs: durationValue } : {}),
                  });
                  if (durationValue > 0) setDuration(durationValue);
                }
              }
            },
            onError: event => { if (!disposed) setError(platformError('youtube', event.data)); },
            onAutoplayBlocked: () => {
              if (disposed) return;
              setPlaybackBlocked(true);
              setPlayerError('Tu navegador bloqueó la reproducción automática. Pulsa Reproducir para continuar.');
            },
          },
        });
      }).catch(error => {
        if (!disposed) setError(error instanceof Error ? error.message : 'No se pudo iniciar el reproductor de YouTube.');
      });
    } else {
      loadPlayerApi('soundcloud').then(api => {
        if (disposed || !soundCloudFrameRef.current) return;
        const soundCloud = api as SoundCloudApi;
        const widget = soundCloud.Widget(soundCloudFrameRef.current);
        soundCloudWidgetRef.current = widget;
        const events = soundCloud.Widget.Events;
        const boundEvents = [events.READY, events.ERROR, events.FINISH, events.PLAY, events.PAUSE, events.PLAY_PROGRESS, events.SEEK]
          .filter((event): event is string => typeof event === 'string');
        teardownSoundCloud = () => {
          for (const event of boundEvents) widget.unbind(event);
        };
        widget.bind(events.READY, () => {
          if (disposed) return;
          clearError();
          lastLoadedKeyRef.current = itemKey;
          playerReadyRef.current = true;
          setPlayerReady(true);
          applyLocalVolume();
          confirmSoundCloudVolume(widget);
          const latest = currentRef.current;
          const position = expectedWatchPosition(sessionSnapshot(latest as WatchPlayerProps), Date.now());
          if (latest.playing) {
            widget.seekTo(position);
            playLocal();
          } else {
            widget.seekTo(position);
            widget.pause();
          }
          widget.getCurrentSound(sound => {
            const title = sound?.title;
            const durationValue = sound?.duration ?? 0;
            if (title || durationValue > 0) {
              propsRef.current.onMetadata({
                title: title ?? current.title,
                ...(durationValue > 0 ? { durationMs: durationValue } : {}),
              });
            }
            if (durationValue > 0) setDuration(durationValue);
          });
        });
        widget.bind(events.ERROR, () => {
          if (!disposed) setError(platformError('soundcloud', 0));
        });
        widget.bind(events.FINISH, () => {
          if (disposed || !propsRef.current.canControl || endedKeyRef.current === current.id) return;
          endedKeyRef.current = current.id;
          propsRef.current.onEnded();
        });
        widget.bind(events.PLAY, () => {
          if (disposed || programmaticSoundCloudCommandRef.current || !propsRef.current.canControl) return;
          propsRef.current.onPlay();
        });
        widget.bind(events.PAUSE, () => {
          if (disposed || programmaticSoundCloudCommandRef.current || !propsRef.current.canControl) return;
          widget.getPosition(position => propsRef.current.onPause(Math.max(0, position)));
        });
        widget.bind(events.PLAY_PROGRESS, event => {
          const position = (event as { currentPosition?: number } | undefined)?.currentPosition;
          if (typeof position === 'number' && Number.isFinite(position)) {
            setCurrentPositionMs(Math.max(0, position));
          }
        });
        widget.bind(events.SEEK, () => {
          if (disposed || programmaticSoundCloudCommandRef.current || !propsRef.current.canControl) return;
          widget.getPosition(position => {
            if (Number.isFinite(position)) propsRef.current.onSeek(Math.max(0, position));
          });
        });
        // The keyed iframe already contains this URL. Reloading it here can
        // replace the frame after Widget(frame) has bound to it.
      }).catch(error => {
        if (!disposed) setError(error instanceof Error ? error.message : 'No se pudo iniciar el reproductor de SoundCloud.');
      });
      timer = window.setTimeout(() => {
        if (!disposed && !playerReadyRef.current) {
          setError('SoundCloud no confirmó la carga de la pista. Puede estar restringida para incrustación.');
        }
      }, 15000);
    }

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      teardownSoundCloud?.();
      const player = youtubePlayerRef.current;
      youtubePlayerRef.current = null;
      player?.destroy();
      soundCloudWidgetRef.current = null;
      playerReadyRef.current = false;
      lastLoadedKeyRef.current = '';
    };
  }, [current?.id, current?.platform, current?.contentId, sessionKey, applyLocalVolume, confirmSoundCloudVolume, clearError, playLocal, setError]);

  useEffect(() => {
    if (!playerReady || !current || !itemKey || lastLoadedKeyRef.current === itemKey) return;
    lastLoadedKeyRef.current = itemKey;
    endedKeyRef.current = '';
    setDuration(durationMs ?? current.durationMs ?? 0);
    const expected = Math.max(0, getExpectedPosition());
    if (current.platform === 'youtube' && youtubePlayerRef.current) {
      const player = youtubePlayerRef.current;
      if (playing) player.loadVideoById({ videoId: current.contentId, startSeconds: expected / 1000 });
      else player.cueVideoById({ videoId: current.contentId, startSeconds: expected / 1000 });
      return;
    }
    const widget = soundCloudWidgetRef.current;
    if (current.platform === 'soundcloud' && widget) {
      widget.load(current.canonicalUrl, {
        auto_play: false,
        visual: true,
        hide_related: true,
        show_comments: false,
        show_user: true,
        show_reposts: false,
        single_active: true,
        callback: () => {
          applyLocalVolume();
          confirmSoundCloudVolume(widget);
          widget.seekTo(expected);
          if (playing) playLocal();
          else pauseLocal();
        },
      });
    }
  }, [current, current?.platform, current?.contentId, current?.canonicalUrl, itemKey, playerReady,
    playing, durationMs, getExpectedPosition, applyLocalVolume, confirmSoundCloudVolume, playLocal, pauseLocal]);

  useEffect(() => {
    if (playerReadyRef.current) applyLocalVolume();
  }, [localVolume, muted, playerReady, applyLocalVolume]);

  useEffect(() => {
    if (!playerReady || !current) return;
    if (playing) playLocal();
    else pauseLocal();
  }, [playing, playerReady, current?.id, playLocal, pauseLocal]);

  useEffect(() => {
    if (!playerReady || !current) return;
    const interval = window.setInterval(() => {
      const expected = expectedWatchPosition(sessionSnapshot(currentRef.current as WatchPlayerProps), Date.now());
      const reconcile = (position: number) => {
        if (!Number.isFinite(position)) return;
        const actual = Math.max(0, position);
        setCurrentPositionMs(actual);
        // Drift at or below 2 s is intentionally ignored to avoid perceptible jumps.
        if (shouldCorrectWatchDrift(expected, actual)) seekLocal(expected);
      };
      if (currentRef.current.current?.platform === 'soundcloud' && soundCloudWidgetRef.current) {
        soundCloudWidgetRef.current.getPosition(reconcile);
      } else {
        reconcile(currentTime());
      }
      if (currentRef.current.playing && currentRef.current.current?.platform === 'soundcloud') {
        soundCloudWidgetRef.current?.isPaused(paused => {
          if (!paused) return;
          setPlaybackBlocked(true);
          setPlayerError('Tu navegador puede haber bloqueado la reproducción. Pulsa Reproducir para activarla.');
        });
      }
    }, 4000);
    return () => window.clearInterval(interval);
  }, [current?.id, playerReady, currentTime, seekLocal]);

  useEffect(() => {
    if (!playerReady || !current) return;
    if (playing) return;
    if (current.platform === 'soundcloud' && soundCloudWidgetRef.current) {
      const widget = soundCloudWidgetRef.current;
      widget.getPosition(actual => {
        if (currentRef.current.playing || widget !== soundCloudWidgetRef.current) return;
        if (shouldCorrectWatchDrift(positionMs, actual)) seekLocal(positionMs);
        // SoundCloud may resume after seekTo even if the session remains paused.
        widget.isPaused(paused => {
          if (paused || currentRef.current.playing || widget !== soundCloudWidgetRef.current) return;
          programmaticSoundCloudCommandRef.current = true;
          widget.pause();
          window.setTimeout(() => { programmaticSoundCloudCommandRef.current = false; }, 1200);
        });
      });
      return;
    }
    const actual = currentTime();
    if (shouldCorrectWatchDrift(positionMs, actual)) seekLocal(positionMs);
  }, [positionMs, playing, playerReady, current?.id, currentTime, seekLocal]);

  useEffect(() => {
    const frame = soundCloudFrameRef.current;
    if (!frame) return;
    frame.style.pointerEvents = canControl ? 'auto' : 'none';
    frame.tabIndex = canControl ? 0 : -1;
  }, [canControl, current?.platform, playerReady]);

  const onPlayClick = () => {
    if (!canControl) return;
    if (currentRef.current.playing) {
      if (currentRef.current.current?.platform === 'soundcloud' && soundCloudWidgetRef.current) {
        soundCloudWidgetRef.current.getPosition(position => {
          pauseLocal();
          propsRef.current.onPause(Math.max(0, position));
        });
        return;
      }
      const position = currentTime();
      pauseLocal();
      propsRef.current.onPause(position);
    } else {
      playLocal(true);
      propsRef.current.onPlay();
    }
  };

  const onRetryClick = () => {
    audioActivatedRef.current = true;
    setPlaybackBlocked(false);
    setPlayerError(null);
    applyLocalVolume();
    playLocal(true);
  };

  const applySeek = () => {
    if (!canControl || seekPreviewMs === null) return;
    seekLocal(seekPreviewMs);
    propsRef.current.onSeek(seekPreviewMs);
    setSeekPreviewMs(null);
  };

  if (!current) return null;

  const visiblePosition = seekPreviewMs ?? currentPositionMs;
  const contentVolume = clampWatchVolume(localVolume);
  return (
    <section
      className="w-full rounded-xl border border-border bg-card/75 shadow-lg shadow-primary/5 backdrop-blur-xl"
      aria-label="Reproductor sincronizado"
      data-testid="watch-player"
    >
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
        {current.platform === 'youtube'
          ? <Play className="h-4 w-4 text-primary" aria-hidden="true" />
          : <Music2 className="h-4 w-4 text-primary" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground" data-testid="text-watch-title">
            {current.title || (current.platform === 'youtube' ? 'Vídeo de YouTube' : 'Pista de SoundCloud')}
          </p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {current.platform === 'youtube' ? 'YouTube · visionado y audio compartidos' : 'SoundCloud · audio compartido'}
          </p>
        </div>
        <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
          Sincronizado
        </span>
      </div>

      <div className="overflow-x-auto p-3" data-testid="watch-embed-viewport">
        {current.platform === 'youtube' ? (
          // Keep the official player visible and at least 480×270; never use audio-only/hidden playback.
          <div className="h-[270px] w-[480px] max-w-none overflow-hidden rounded-lg bg-background">
            <div
              key={`${sessionKey}:${itemKey}`}
              ref={mountRef}
              className="h-[270px] w-[480px] max-w-none"
              aria-label="Reproductor oficial visible de YouTube"
              data-testid="watch-youtube-player"
            />
          </div>
        ) : (
          <iframe
            key={`${sessionKey}:${itemKey}`}
            ref={soundCloudFrameRef}
            title={`Reproductor oficial de SoundCloud: ${current.title}`}
            src={`https://w.soundcloud.com/player/?url=${encodeURIComponent(current.canonicalUrl)}&auto_play=false&visual=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&single_active=true`}
            width="100%"
            height="200"
            scrolling="no"
            frameBorder="no"
            allow="autoplay"
            className="min-h-[200px] w-full min-w-[200px] rounded-lg border-0 bg-background"
            data-testid="watch-soundcloud-player"
          />
        )}
      </div>

      {playerError && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive" role="alert" data-testid="status-watch-player-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p>{playerError}</p>
            {playbackBlocked && (
              <button
                type="button"
                onClick={onRetryClick}
                className="mt-1 inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-background/50 px-2 py-1 font-medium hover:bg-destructive/10"
                data-testid="button-watch-player-retry"
              >
                <RotateCw className="h-3 w-3" aria-hidden="true" />
                Reproducir en este dispositivo
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-3 py-2">
        <button
          type="button"
          onClick={onPlayClick}
          disabled={!canControl || !playerReady}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={playing ? 'Pausar contenido' : 'Reproducir contenido'}
          data-testid="button-watch-play-pause"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {playing ? 'Pausar' : 'Reproducir'}
        </button>

        {duration > 0 && (
          <div className="flex min-w-[180px] flex-1 items-center gap-2">
            <span className="w-9 text-right font-mono text-[10px] text-muted-foreground">{formatTime(visiblePosition)}</span>
            <input
              type="range"
              min={0}
              max={duration}
              step={1000}
              value={Math.min(visiblePosition, duration)}
              disabled={!canControl || !playerReady}
              onChange={event => {
                const value = Number(event.target.value);
                setSeekPreviewMs(value);
                seekLocal(value);
              }}
              onPointerUp={applySeek}
              onKeyUp={applySeek}
              className="h-1.5 min-w-[80px] flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Posición del contenido"
              data-testid="input-watch-seek"
            />
            <span className="w-9 font-mono text-[10px] text-muted-foreground">{formatTime(duration)}</span>
          </div>
        )}

        <label className="ml-auto inline-flex items-center gap-2 text-muted-foreground" title="Volumen local: solo afecta a este dispositivo">
          {contentVolume === 0 || muted
            ? <VolumeX className="h-4 w-4" aria-hidden="true" />
            : <Volume2 className="h-4 w-4" aria-hidden="true" />}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : contentVolume}
            onChange={event => onVolumeChange(clampWatchVolume(Number(event.target.value)))}
            className="h-1.5 w-20 cursor-pointer accent-primary"
            aria-label="Volumen local del reproductor"
            data-testid="input-watch-volume"
          />
        </label>
      </div>
    </section>
  );
}