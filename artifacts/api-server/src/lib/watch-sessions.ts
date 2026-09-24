import { randomUUID } from "crypto";

export type WatchScope = "voice" | "dm";
export type WatchPlatform = "youtube" | "soundcloud";

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

export interface WatchSession {
  controllerUserId: number;
  allowEveryone: boolean;
  current: WatchItem | null;
  queue: WatchItem[];
  playing: boolean;
  positionMs: number;
  updatedAtMs: number;
  revision: number;
}

export interface WatchSessionSnapshot extends WatchSession {
  serverNowMs: number;
  watchingUserIds: number[];
}

export const MAX_WATCH_QUEUE_SIZE = 50;
export const WATCH_DRIFT_CORRECTION_THRESHOLD_MS = 2_000;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const SOUNDCLOUD_SLUG = /^[\p{L}\p{N}\p{M}_-]+$/u;

export type WatchControlAction =
  | "play"
  | "pause"
  | "seek"
  | "skip"
  | "reorder"
  | "remove"
  | "transfer"
  | "everyone"
  | "end"
  | "ended"
  | "metadata";

const CONTROLLER_ONLY_ACTIONS = new Set<WatchControlAction>([
  "transfer",
  "everyone",
  "end",
  "metadata",
]);

export interface NormalizedWatchLink {
  platform: WatchPlatform;
  contentId: string;
  canonicalUrl: string;
  title: string;
}

/**
 * Parse a direct public YouTube video or SoundCloud track permalink.
 * This function never fetches, resolves, downloads, or proxies external media.
 */
export function normalizeWatchLink(input: unknown): NormalizedWatchLink {
  if (typeof input !== "string" || input.length > 2_048) {
    throw new Error("Pega un enlace válido de YouTube o SoundCloud.");
  }

  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error("Pega un enlace válido de YouTube o SoundCloud.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username || parsed.password || parsed.port) {
    throw new Error("Solo se aceptan enlaces públicos de YouTube o SoundCloud.");
  }

  const host = parsed.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    let id: string | null = null;
    if (host === "youtu.be") {
      const match = parsed.pathname.match(/^\/([^/]+)\/?$/);
      id = match?.[1] ?? null;
    } else if (parsed.pathname === "/watch") {
      const videoIds = parsed.searchParams.getAll("v");
      id = videoIds.length === 1 ? videoIds[0] : null;
    } else {
      const match = parsed.pathname.match(/^\/(shorts|live|embed)\/([^/]+)\/?$/);
      id = match?.[2] ?? null;
    }
    if (!id || !YOUTUBE_ID.test(id)) {
      throw new Error("Ese enlace no contiene un vídeo de YouTube compatible.");
    }
    return {
      platform: "youtube",
      contentId: id,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      title: `Vídeo de YouTube ${id}`,
    };
  }

  if (SOUNDCLOUD_HOSTS.has(host)) {
    const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
    const rawParts = path.slice(1).split("/");
    if (!path.startsWith("/") || path.startsWith("//") || rawParts.length !== 2) {
      throw new Error("Pega el enlace directo de una pista pública de SoundCloud.");
    }
    let parts: string[];
    try {
      parts = rawParts.map(part => decodeURIComponent(part).normalize("NFC"));
    } catch {
      throw new Error("El enlace de SoundCloud contiene caracteres no válidos.");
    }
    if (parts.some(part => !part || part === "." || part === ".." || !SOUNDCLOUD_SLUG.test(part))) {
      throw new Error("El enlace de SoundCloud contiene un nombre de pista no válido.");
    }
    const contentId = parts.join("/");
    const canonicalPath = parts.map(part => encodeURIComponent(part)).join("/");
    return {
      platform: "soundcloud",
      contentId,
      canonicalUrl: `https://soundcloud.com/${canonicalPath}`,
      title: `SoundCloud: ${contentId}`,
    };
  }

  throw new Error("Solo se aceptan enlaces de YouTube o SoundCloud; no se admiten otras plataformas.");
}

function sessionKey(scope: WatchScope, targetId: number, userId?: number): string {
  if (scope === "voice") return `voice:${targetId}`;
  if (userId === undefined || userId <= 0) {
    throw new Error("Se necesitan ambos participantes para identificar una llamada directa.");
  }
  return `dm:${Math.min(targetId, userId)}:${Math.max(targetId, userId)}`;
}

function copyItem(item: WatchItem | null): WatchItem | null {
  return item ? { ...item } : null;
}

function copySession(session: WatchSession): WatchSession {
  return {
    ...session,
    current: copyItem(session.current),
    queue: session.queue.map(item => ({ ...item })),
  };
}

export function createWatchItem(
  link: NormalizedWatchLink,
  userId: number,
  displayName: string,
): WatchItem {
  return {
    id: makeWatchItemId(),
    ...link,
    addedById: userId,
    addedByName: displayName,
  };
}

export function getExpectedWatchPosition(session: WatchSession, nowMs: number): number {
  if (!session.playing || !session.current) return session.positionMs;
  const elapsedMs = Math.max(0, nowMs - session.updatedAtMs);
  const position = session.positionMs + elapsedMs;
  return session.current.durationMs === undefined
    ? position
    : Math.min(position, session.current.durationMs);
}

export function advanceWatchCursor(session: WatchSession, nowMs: number): void {
  session.positionMs = getExpectedWatchPosition(session, nowMs);
  session.updatedAtMs = nowMs;
}

export function canControlWatchAction(
  session: WatchSession,
  userId: number,
  action: WatchControlAction,
): boolean {
  if (CONTROLLER_ONLY_ACTIONS.has(action)) return session.controllerUserId === userId;
  return session.controllerUserId === userId || session.allowEveryone;
}

export function isActiveWatchCallParticipant(
  call: { active: boolean; callerUserId: number; recipientUserId: number },
  participantUserId: number,
  userAId: number,
  userBId: number,
): boolean {
  const callUserIds = [call.callerUserId, call.recipientUserId].sort((a, b) => a - b);
  const expectedUserIds = [userAId, userBId].sort((a, b) => a - b);
  return call.active
    && callUserIds[0] === expectedUserIds[0]
    && callUserIds[1] === expectedUserIds[1]
    && (participantUserId === userAId || participantUserId === userBId);
}

export class WatchSessionStore {
  private readonly sessions = new Map<string, WatchSession>();
  private readonly watchers = new Map<string, Set<number>>();

  get(scope: WatchScope, targetId: number, userId?: number): WatchSession | null {
    const session = this.sessions.get(sessionKey(scope, targetId, userId));
    return session ? copySession(session) : null;
  }

  has(scope: WatchScope, targetId: number, userId?: number): boolean {
    return this.sessions.has(sessionKey(scope, targetId, userId));
  }

  start(
    scope: WatchScope,
    targetId: number,
    controllerUserId: number,
    current: WatchItem,
    nowMs: number,
    userId?: number,
  ): WatchSession {
    if (this.has(scope, targetId, userId)) throw new Error("Ya hay una sesión compartida activa.");
    const session: WatchSession = {
      controllerUserId,
      allowEveryone: false,
      current: { ...current },
      queue: [],
      playing: true,
      positionMs: 0,
      updatedAtMs: nowMs,
      revision: 1,
    };
    const key = sessionKey(scope, targetId, userId);
    this.sessions.set(key, session);
    this.watchers.set(key, new Set([controllerUserId]));
    return copySession(session);
  }

  join(scope: WatchScope, targetId: number, watcherUserId: number, userId?: number): WatchSession | null {
    const key = sessionKey(scope, targetId, userId);
    const session = this.sessions.get(key);
    if (!session) return null;
    const watchers = this.watchers.get(key) ?? new Set<number>();
    watchers.add(watcherUserId);
    this.watchers.set(key, watchers);
    return copySession(session);
  }

  leave(scope: WatchScope, targetId: number, watcherUserId: number, userId?: number): WatchSession | null {
    const key = sessionKey(scope, targetId, userId);
    const session = this.sessions.get(key);
    if (!session) return null;
    const watchers = this.watchers.get(key);
    if (!watchers?.delete(watcherUserId)) return copySession(session);
    if (watchers.size === 0) {
      this.end(scope, targetId, userId);
      return null;
    }
    if (session.controllerUserId === watcherUserId) {
      // Transfer to the longest-watching remaining participant, deterministically.
      session.controllerUserId = watchers.values().next().value!;
      session.revision += 1;
    }
    return copySession(session);
  }

  isWatching(scope: WatchScope, targetId: number, watcherUserId: number, userId?: number): boolean {
    return this.watchers.get(sessionKey(scope, targetId, userId))?.has(watcherUserId) ?? false;
  }

  save(scope: WatchScope, targetId: number, next: WatchSession, userId?: number): WatchSession {
    const key = sessionKey(scope, targetId, userId);
    const previous = this.sessions.get(key);
    if (!previous) throw new Error("La sesión compartida ya terminó.");
    const stored = {
      ...copySession(next),
      revision: previous.revision + 1,
    };
    this.sessions.set(key, stored);
    return copySession(stored);
  }

  end(scope: WatchScope, targetId: number, userId?: number): boolean {
    const key = sessionKey(scope, targetId, userId);
    this.watchers.delete(key);
    return this.sessions.delete(key);
  }

  snapshot(
    scope: WatchScope,
    targetId: number,
    nowMs: number,
    userId?: number,
  ): WatchSessionSnapshot | null {
    const session = this.sessions.get(sessionKey(scope, targetId, userId));
    if (!session) return null;
    const currentPositionMs = getExpectedWatchPosition(session, nowMs);
    return {
      ...copySession(session),
      positionMs: currentPositionMs,
      updatedAtMs: nowMs,
      serverNowMs: nowMs,
      watchingUserIds: [...(this.watchers.get(sessionKey(scope, targetId, userId)) ?? [])],
    };
  }
}

export function isWatchPosition(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function makeWatchItemId(): string {
  return randomUUID();
}