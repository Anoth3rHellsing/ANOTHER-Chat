export type VideoQuality = 'low' | 'medium' | 'high';

export interface AudioVideoSettings {
  audioInputId: string;
  audioOutputId: string;
  volume: number;
  videoQuality: VideoQuality;
  advancedNoiseSuppression: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

const DEFAULT_SETTINGS: AudioVideoSettings = {
  audioInputId: '', audioOutputId: '', volume: 1, videoQuality: 'medium',
  advancedNoiseSuppression: true, noiseSuppression: true,
  echoCancellation: true, autoGainControl: true,
};

function storageKey(userId: number): string {
  return `anp_settings_${userId}`;
}

export function loadSettings(userId: number): AudioVideoSettings {
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof localStorage === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    let raw = localStorage.getItem(storageKey(userId));
    // Preserve the earlier browser-wide preferences for the first account
    // opening this browser after upgrading. Never copy them to other accounts.
    if (!raw && !localStorage.getItem('anp_settings_migrated_user')) {
      const legacy = localStorage.getItem('anp_settings');
      if (legacy) {
        raw = legacy;
        localStorage.setItem(storageKey(userId), legacy);
        localStorage.setItem('anp_settings_migrated_user', String(userId));
      }
    }
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        audioInputId: typeof parsed.audioInputId === 'string' ? parsed.audioInputId : '',
        audioOutputId: typeof parsed.audioOutputId === 'string' ? parsed.audioOutputId : '',
        volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
          ? Math.max(0, Math.min(1, parsed.volume)) : 1,
        videoQuality: ['low', 'medium', 'high'].includes(parsed.videoQuality) ? parsed.videoQuality : 'medium',
        ...Object.fromEntries(
          (['advancedNoiseSuppression', 'noiseSuppression', 'echoCancellation', 'autoGainControl'] as const)
            .filter(key => typeof parsed[key] === 'boolean').map(key => [key, parsed[key]]),
        ),
      };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(userId: number, s: AudioVideoSettings): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

/** Safely close an AudioContext — guards against "already closed" errors. */
export function safeCloseAudioContext(ctx: AudioContext | null | undefined): void {
  if (ctx && ctx.state !== 'closed') {
    ctx.close().catch(() => {});
  }
}

export function videoConstraintsFromQuality(quality: VideoQuality): MediaTrackConstraints {
  switch (quality) {
    case 'low':    return { width: 320,  height: 240,  frameRate: 15 };
    case 'high':   return { width: 1280, height: 720,  frameRate: 30 };
    case 'medium':
    default:       return { width: 640,  height: 480,  frameRate: 24 };
  }
}

export function callMediaConstraints(
  audioInputId: string | undefined,
  videoQuality: VideoQuality,
  withVideo = false,
  processing: Partial<Pick<AudioVideoSettings, 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>> =
    DEFAULT_SETTINGS,
): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: processing.echoCancellation ?? true,
      noiseSuppression: processing.noiseSuppression ?? true,
      autoGainControl: processing.autoGainControl ?? true,
      ...(audioInputId ? { deviceId: { exact: audioInputId } } : {}),
    },
    video: withVideo ? videoConstraintsFromQuality(videoQuality) : false,
  };
}
