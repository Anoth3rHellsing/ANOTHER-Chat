export interface SoundboardSettings {
  volume: number;
  muted: boolean;
}

const DEFAULT_SETTINGS: SoundboardSettings = {
  volume: 0.5,
  muted: false,
};

function safeVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : DEFAULT_SETTINGS.volume;
}

function storageKey(userId: number): string {
  return `anp_soundboard_settings_${userId}`;
}

export function loadSoundboardSettings(userId: number): SoundboardSettings {
  if (!Number.isSafeInteger(userId) || userId < 0 || typeof localStorage === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        volume: safeVolume(parsed.volume),
        muted: typeof parsed.muted === 'boolean' ? parsed.muted : false,
      };
    }
  } catch {
    // Ignore and fallback to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSoundboardSettings(userId: number, settings: SoundboardSettings): boolean {
  if (!Number.isSafeInteger(userId) || userId < 0 || typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify({
      volume: safeVolume(settings.volume),
      muted: settings.muted,
    }));
    return true;
  } catch {
    return false;
  }
}
