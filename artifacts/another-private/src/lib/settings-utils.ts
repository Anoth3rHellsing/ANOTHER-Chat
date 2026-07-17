export type VideoQuality = 'low' | 'medium' | 'high';

export interface AudioVideoSettings {
  audioInputId: string;
  audioOutputId: string;
  volume: number;
  videoQuality: VideoQuality;
}

const SETTINGS_KEY = 'anp_settings';

export function loadSettings(): AudioVideoSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { audioInputId: '', audioOutputId: '', volume: 1, videoQuality: 'medium', ...JSON.parse(raw) };
  } catch {}
  return { audioInputId: '', audioOutputId: '', volume: 1, videoQuality: 'medium' };
}

export function saveSettings(s: AudioVideoSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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
