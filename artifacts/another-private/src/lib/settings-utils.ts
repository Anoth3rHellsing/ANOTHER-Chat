export interface AudioVideoSettings {
  audioInputId: string;
  audioOutputId: string;
  volume: number;
}

const SETTINGS_KEY = 'anp_settings';

export function loadSettings(): AudioVideoSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { audioInputId: '', audioOutputId: '', volume: 1, ...JSON.parse(raw) };
  } catch {}
  return { audioInputId: '', audioOutputId: '', volume: 1 };
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
