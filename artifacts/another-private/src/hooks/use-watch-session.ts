import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRealtimeMessages, useRealtimeTransport } from '@/providers/realtime-transport';
import {
  expectedWatchPosition,
  isWatchAction,
  isWatchScope,
  isWatchStateMessage,
  normalizeWatchUrl,
  type WatchAction,
  type WatchScope,
  type WatchSessionState,
} from '@/lib/watch-session';

interface WatchSessionOptions {
  userId: number | undefined;
  scope: WatchScope | null;
  targetId: number | null;
  enabled: boolean;
}

export interface WatchSyncTarget {
  scope: WatchScope;
  targetId: number;
}

export interface WatchSessionController {
  session: WatchSessionState | null;
  error: string | null;
  canControl: boolean;
  isController: boolean;
  start: (url: string) => { ok: true } | { ok: false; message: string };
  add: (url: string) => { ok: true } | { ok: false; message: string };
  control: (action: WatchAction, values?: {
    positionMs?: number;
    itemId?: string;
    toIndex?: number;
    userId?: number;
    allowEveryone?: boolean;
    title?: string;
    durationMs?: number;
  }) => boolean;
  sync: () => void;
  reportLoadError: (message: string | null) => void;
}

export function useWatchSession({
  userId,
  scope,
  targetId,
  enabled,
}: WatchSessionOptions): WatchSessionController {
  const { send } = useRealtimeTransport();
  const [session, setSession] = useState<WatchSessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targetRef = useRef<WatchSyncTarget | null>(null);
  const serverClockOffsetRef = useRef(0);
  const activeTarget = useMemo<WatchSyncTarget | null>(
    () => enabled && isWatchScope(scope) && Number.isSafeInteger(targetId) && targetId! > 0
      ? { scope, targetId: targetId! }
      : null,
    [enabled, scope, targetId, userId],
  );

  targetRef.current = activeTarget;
  const isController = !!session && userId === session.controllerUserId;
  const canControl = !!session && (isController || session.allowEveryone);

  const sendSync = useCallback((target: WatchSyncTarget | null) => {
    if (!target) return;
    send({ type: 'watch:sync', ...target });
  }, [send]);

  const sync = useCallback(() => sendSync(targetRef.current), [sendSync]);

  useEffect(() => {
    setSession(null);
    setError(null);
    sendSync(activeTarget);
  }, [activeTarget?.scope, activeTarget?.targetId, sendSync]);

  useRealtimeMessages(['connected', 'watch:state', 'watch:error'], message => {
    const target = targetRef.current;
    if (!target) return;
    if (message.type === 'connected') {
      sendSync(target);
      return;
    }

    if (message.type === 'watch:state') {
      if (!isWatchStateMessage(message)) return;
      if (message.data.scope !== target.scope || message.data.targetId !== target.targetId) return;
      if (message.data.session) {
        serverClockOffsetRef.current = message.data.session.serverNowMs - Date.now();
      }
      setSession(message.data.session);
      setError(null);
      return;
    }

    const data = message.data as {
      message?: unknown;
      scope?: unknown;
      targetId?: unknown;
    } | undefined;
    if (data?.scope !== undefined && data.scope !== target.scope) return;
    if (data?.targetId !== undefined && data.targetId !== target.targetId) return;
    setError(typeof data?.message === 'string' ? data.message : 'No se pudo actualizar la sesión.');
  });

  const start = useCallback((url: string) => {
    const target = targetRef.current;
    if (!target) return { ok: false as const, message: 'No hay una llamada activa.' };
    const normalized = normalizeWatchUrl(url);
    if (!normalized.ok) {
      setError(normalized.message);
      return { ok: false as const, message: normalized.message };
    }
    setError(null);
    send({ type: 'watch:start', ...target, url });
    return { ok: true as const };
  }, [send]);

  const add = useCallback((url: string) => {
    const target = targetRef.current;
    if (!target) return { ok: false as const, message: 'No hay una llamada activa.' };
    const normalized = normalizeWatchUrl(url);
    if (!normalized.ok) {
      setError(normalized.message);
      return { ok: false as const, message: normalized.message };
    }
    setError(null);
    send({ type: 'watch:add', ...target, url });
    return { ok: true as const };
  }, [send]);

  const control = useCallback((action: WatchAction, values: {
    positionMs?: number;
    itemId?: string;
    toIndex?: number;
    userId?: number;
    allowEveryone?: boolean;
    title?: string;
    durationMs?: number;
  } = {}) => {
    const target = targetRef.current;
    if (!target || !isWatchAction(action)) return false;
    const latest = session;
    const controllerOnly = action === 'end' || action === 'metadata'
      || action === 'transfer' || action === 'everyone'
      || (action === 'ended' && !latest?.allowEveryone);
    if (latest && userId !== latest.controllerUserId
      && (controllerOnly || !latest.allowEveryone)) {
      setError('Solo quien tiene el control puede cambiar la reproducción.');
      return false;
    }
    if (!latest) {
      setError('No hay una sesión compartida activa.');
      return false;
    }
    send({ type: 'watch:control', ...target, action, ...values });
    return true;
  }, [send, session, userId]);

  const reportLoadError = useCallback((message: string | null) => {
    setError(message);
  }, []);

  const localSession = session ? {
    ...session,
    updatedAtMs: session.updatedAtMs - serverClockOffsetRef.current,
    serverNowMs: session.serverNowMs - serverClockOffsetRef.current,
  } : null;

  return {
    session: localSession,
    error,
    canControl,
    isController,
    start,
    add,
    control,
    sync,
    reportLoadError,
  };
}