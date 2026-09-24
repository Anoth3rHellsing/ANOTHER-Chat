export interface Clip {
  id: number;
  serverId: number;
  name: string;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  url: string;
  uploadedBy: number;
  createdAt: string;
}

export interface SoundboardPlaybackClip {
  id: number;
  serverId: number;
  url: string;
  name: string;
}

export interface SoundboardPlayEventData {
  clipId: number;
  serverId: number;
  url: string;
  name: string;
  triggeredById: number;
  triggeredByName: string;
  callType: 'voice' | 'dm';
  channelId?: number;
  peerId?: number;
}

export interface SoundboardPlayEvent {
  type: 'soundboard:play';
  data: SoundboardPlayEventData;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isPlayableSoundboardUrl(value: unknown): value is string {
  return typeof value === 'string'
    && /^\/api\/soundboard\/clips\/[1-9]\d*\/audio$/.test(value);
}

export function isSoundboardPlaybackClip(value: unknown): value is SoundboardPlaybackClip {
  if (!value || typeof value !== 'object') return false;
  const clip = value as Partial<SoundboardPlaybackClip>;
  return isPositiveSafeInteger(clip.id)
    && isPositiveSafeInteger(clip.serverId)
    && typeof clip.name === 'string'
    && clip.name.trim().length > 0
    && isPlayableSoundboardUrl(clip.url);
}

export function isSoundboardPlayEvent(value: unknown): value is SoundboardPlayEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<SoundboardPlayEvent>;
  if (event.type !== 'soundboard:play' || !event.data || typeof event.data !== 'object') return false;

  const data = event.data as Partial<SoundboardPlayEventData>;
  if (!isPositiveSafeInteger(data.clipId)
    || !isPositiveSafeInteger(data.serverId)
    || !isPlayableSoundboardUrl(data.url)
    || typeof data.name !== 'string'
    || data.name.trim().length === 0
    || !isPositiveSafeInteger(data.triggeredById)
    || typeof data.triggeredByName !== 'string'
    || data.triggeredByName.trim().length === 0) {
    return false;
  }

  if (data.callType === 'voice') return isPositiveSafeInteger(data.channelId);
  if (data.callType === 'dm') return isPositiveSafeInteger(data.peerId);
  return false;
}