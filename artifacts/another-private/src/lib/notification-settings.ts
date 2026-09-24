export type NotificationLevel = 'all' | 'mentions' | 'none';

export interface NotificationSettings {
  serverLevels: Record<string, NotificationLevel>;
  channelLevels: Record<string, NotificationLevel>;
  muteUntil: number | null;
  soundEnabled: boolean;
  showPreview: boolean;
  browserEnabled: boolean;
}

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  serverLevels: {},
  channelLevels: {},
  muteUntil: null,
  soundEnabled: true,
  showPreview: false,
  browserEnabled: false,
};

function freshDefaults(): NotificationSettings {
  return {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    serverLevels: Object.create(null),
    channelLevels: Object.create(null),
  };
}

const LEVELS = new Set<NotificationLevel>(['all', 'mentions', 'none']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeLevels(value: unknown): Record<string, NotificationLevel> {
  const levels: Record<string, NotificationLevel> = Object.create(null);
  if (!isRecord(value)) return levels;

  for (const [id, level] of Object.entries(value)) {
    if (/^\d+$/.test(id) && LEVELS.has(level as NotificationLevel)) {
      levels[id] = level as NotificationLevel;
    }
  }
  return levels;
}

function sanitizeSettings(value: unknown): NotificationSettings {
  if (!isRecord(value)) return freshDefaults();

  return {
    serverLevels: sanitizeLevels(value.serverLevels),
    channelLevels: sanitizeLevels(value.channelLevels),
    muteUntil: typeof value.muteUntil === 'number' && Number.isFinite(value.muteUntil)
      ? value.muteUntil
      : null,
    soundEnabled: typeof value.soundEnabled === 'boolean' ? value.soundEnabled : true,
    showPreview: typeof value.showPreview === 'boolean' ? value.showPreview : false,
    browserEnabled: typeof value.browserEnabled === 'boolean' ? value.browserEnabled : false,
  };
}

function storageKey(userId: number): string {
  return `anp_notification_settings_${userId}`;
}

export function loadNotificationSettings(userId: number): NotificationSettings {
  if (!Number.isSafeInteger(userId) || userId < 0 || typeof localStorage === 'undefined') {
    return freshDefaults();
  }

  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw ? sanitizeSettings(JSON.parse(raw)) : freshDefaults();
  } catch {
    return freshDefaults();
  }
}

export function saveNotificationSettings(userId: number, settings: NotificationSettings): boolean {
  if (!Number.isSafeInteger(userId) || userId < 0 || typeof localStorage === 'undefined') return false;

  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(sanitizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

export function resolveChannelLevel(
  settings: NotificationSettings,
  serverId: number,
  channelId: number,
): NotificationLevel {
  const channelLevel = settings.channelLevels[String(channelId)];
  if (channelLevel) return channelLevel;
  return settings.serverLevels[String(serverId)] ?? 'mentions';
}