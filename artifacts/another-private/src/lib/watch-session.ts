export type WatchScope = 'voice' | 'dm';
export type WatchPlatform = 'youtube' | 'soundcloud';
export type WatchAction =
  | 'play'
  | 'pause'
  | 'seek'
  | 'skip'
  | 'reorder'
  | 'remove'
  | 'transfer'
  | 'everyone'
  | 'end'
  | 'ended'
  | 'metadata';

export interface WatchItem {
  id: string;
  platform: WatchPlatform;
  contentId: string;
  canonicalUrl: string;
  addedById: number;
  addedByName: string;
  title: string;
  durationMs?: number;
}

export interface WatchSessionState {
  controllerUserId: number;
  allowEveryone: boolean;
  current: WatchItem | null;
  queue: WatchItem[];
  playing: boolean;
  positionMs: number;
  updatedAtMs: number;
  serverNowMs: number;
  revision: number;
}

interface WatchStateMessage {
  type: 'watch:state';
  data: {
    scope: WatchScope;
    targetId: number;
    session: WatchSessionState | null;
  };
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
]);
const SOUNDCLOUD_HOSTS = new Set([
  'soundcloud.com',
  'www.soundcloud.com',
  'm.soundcloud.com',
]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SOUNDCLOUD_SLUG = /^[\p{L}\p{N}\p{M}_-]+$/u;

function safeUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password || url.port) return null;
    return url;
  } catch {
    return null;
  }
}

export type WatchUrlResult =
  | { ok: true; platform: WatchPlatform; contentId: string; canonicalUrl: string }
  | { ok: false; message: string };

export function normalizeWatchUrl(value: unknown): WatchUrlResult {
  const url = safeUrl(value);
  if (!url) {
    return { ok: false, message: 'Pega un enlace válido de YouTube o SoundCloud.' };
  }

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    let videoId: string | null = null;
    if (host === 'youtu.be') {
      const match = url.pathname.match(/^\/([^/]+)\/?$/);
      videoId = match?.[1] ?? null;
    } else if (host !== 'youtu.be' && url.pathname === '/watch') {
      const ids = url.searchParams.getAll('v');
      videoId = ids.length === 1 ? ids[0] : null;
    } else if (host !== 'youtu.be') {
      const match = url.pathname.match(/^\/(shorts|live|embed)\/([^/]+)\/?$/);
      videoId = match?.[2] ?? null;
    }

    if (!videoId || !VIDEO_ID.test(videoId)) {
      return { ok: false, message: 'El enlace de YouTube no contiene un identificador de vídeo válido.' };
    }
    return {
      ok: true,
      platform: 'youtube',
      contentId: videoId,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  if (SOUNDCLOUD_HOSTS.has(host)) {
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    const rawSegments = path.slice(1).split('/');
    if (!path.startsWith('/') || path.startsWith('//') || rawSegments.length !== 2) {
      return {
        ok: false,
        message: 'Pega el enlace directo de una pista pública de SoundCloud; no se admiten listas ni enlaces cortos.',
      };
    }
    let segments: string[];
    try {
      segments = rawSegments.map(segment => decodeURIComponent(segment).normalize('NFC'));
    } catch {
      return { ok: false, message: 'El enlace de SoundCloud no es válido.' };
    }
    if (segments.some(segment => !segment || segment === '.' || segment === '..'
      || !SOUNDCLOUD_SLUG.test(segment))) {
      return {
        ok: false,
        message: 'Pega el enlace directo de una pista pública de SoundCloud; no se admiten listas ni enlaces cortos.',
      };
    }
    const contentId = `${segments[0]}/${segments[1]}`;
    const canonicalPath = segments.map(segment => encodeURIComponent(segment)).join('/');
    return {
      ok: true,
      platform: 'soundcloud',
      contentId,
      canonicalUrl: `https://soundcloud.com/${canonicalPath}`,
    };
  }

  return { ok: false, message: 'Solo se admiten enlaces de YouTube y SoundCloud.' };
}

export function isWatchPlatform(value: unknown): value is WatchPlatform {
  return value === 'youtube' || value === 'soundcloud';
}

export function isWatchScope(value: unknown): value is WatchScope {
  return value === 'voice' || value === 'dm';
}

export function isWatchAction(value: unknown): value is WatchAction {
  return value === 'play' || value === 'pause' || value === 'seek' || value === 'skip'
    || value === 'reorder' || value === 'remove' || value === 'transfer'
    || value === 'everyone' || value === 'end' || value === 'ended' || value === 'metadata';
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isWatchItem(value: unknown): value is WatchItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<WatchItem>;
  if (typeof item.id !== 'string' || item.id.length === 0
    || !isWatchPlatform(item.platform)
    || typeof item.contentId !== 'string' || item.contentId.length === 0
    || typeof item.canonicalUrl !== 'string'
    || !isSafeInteger(item.addedById) || item.addedById <= 0
    || typeof item.addedByName !== 'string'
    || typeof item.title !== 'string') return false;

  const normalized = normalizeWatchUrl(item.canonicalUrl);
  return normalized.ok
    && normalized.platform === item.platform
    && normalized.contentId === item.contentId
    && (item.durationMs === undefined || (isSafeInteger(item.durationMs) && item.durationMs > 0));
}

export function isWatchSession(value: unknown): value is WatchSessionState {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<WatchSessionState>;
  return isSafeInteger(session.controllerUserId)
    && session.controllerUserId > 0
    && typeof session.allowEveryone === 'boolean'
    && (session.current === null || isWatchItem(session.current))
    && Array.isArray(session.queue)
    && session.queue.length <= 50
    && session.queue.every(isWatchItem)
    && typeof session.playing === 'boolean'
    && isSafeInteger(session.positionMs)
    && session.positionMs >= 0
    && isSafeInteger(session.updatedAtMs)
    && isSafeInteger(session.serverNowMs)
    && isSafeInteger(session.revision)
    && session.revision >= 0;
}

export function isWatchStateMessage(value: unknown): value is WatchStateMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<WatchStateMessage>;
  const data = message.data;
  if (message.type !== 'watch:state' || !data || typeof data !== 'object'
    || !isWatchScope(data.scope)
    || !isSafeInteger(data.targetId)
    || data.targetId <= 0) return false;
  return data.session === null || isWatchSession(data.session);
}

export function expectedWatchPosition(session: WatchSessionState, nowMs: number): number {
  if (!session.playing) return session.positionMs;
  const elapsedSinceSnapshot = Math.max(0, nowMs - session.updatedAtMs);
  return session.positionMs + elapsedSinceSnapshot;
}

export function clampWatchVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.7;
}

export const WATCH_DRIFT_CORRECTION_THRESHOLD_MS = 2_000;

export function shouldCorrectWatchDrift(expectedMs: number, actualMs: number): boolean {
  return Number.isFinite(expectedMs)
    && Number.isFinite(actualMs)
    && Math.abs(expectedMs - actualMs) > WATCH_DRIFT_CORRECTION_THRESHOLD_MS;
}