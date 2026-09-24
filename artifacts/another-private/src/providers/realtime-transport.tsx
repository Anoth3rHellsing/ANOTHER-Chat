import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

type RealtimeMessage = {
  type: string;
  data?: any;
  [key: string]: any;
};

type RealtimeMessageHandler = (message: RealtimeMessage) => void | Promise<void>;

type RealtimeTransport = {
  send: (message: object) => void;
  sendIfReady: (message: object) => boolean;
  addConnectionListener: (listener: (ready: boolean) => void) => () => void;
  addMessageListener: (types: readonly string[], handler: RealtimeMessageHandler) => () => void;
  retainChannel: (channel: string) => () => void;
};

const RealtimeTransportContext = createContext<RealtimeTransport | null>(null);

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_MS = 500;
const INITIAL_AUTH_RETRY_DELAY_MS = 50;
const MAX_AUTH_RETRY_DELAY_MS = 1_000;
const AUTH_SETTLE_DELAY_MS = 250;

function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${protocol}//${window.location.host}${baseUrl}/ws`;
}

export function RealtimeTransportProvider({ children }: { children: ReactNode }) {
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Map<string, Set<RealtimeMessageHandler>>>(new Map());
  const connectionListenersRef = useRef(new Set<(ready: boolean) => void>());
  const subscriptionCountsRef = useRef<Map<string, number>>(new Map());
  const queuedMessagesRef = useRef<string[]>([]);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authRetryAttemptRef = useRef(0);
  const authRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const authReadyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applicationReadyRef = useRef(false);
  const mountedRef = useRef(false);
  const intentionalCloseRef = useRef(false);

  const sendSerialized = useCallback((serialized: string) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(serialized);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const send = useCallback((message: object) => {
    const serialized = JSON.stringify(message);
    if (!applicationReadyRef.current || !sendSerialized(serialized)) {
      queuedMessagesRef.current.push(serialized);
    }
  }, [sendSerialized]);

  const sendIfReady = useCallback((message: object) =>
    applicationReadyRef.current && sendSerialized(JSON.stringify(message)), [sendSerialized]);

  const addConnectionListener = useCallback((listener: (ready: boolean) => void) => {
    connectionListenersRef.current.add(listener);
    listener(applicationReadyRef.current);
    return () => { connectionListenersRef.current.delete(listener); };
  }, []);

  const addMessageListener = useCallback((
    types: readonly string[],
    handler: RealtimeMessageHandler,
  ) => {
    for (const type of types) {
      const listeners = listenersRef.current.get(type) ?? new Set<RealtimeMessageHandler>();
      listeners.add(handler);
      listenersRef.current.set(type, listeners);
    }

    return () => {
      for (const type of types) {
        const listeners = listenersRef.current.get(type);
        if (!listeners) continue;
        listeners.delete(handler);
        if (listeners.size === 0) listenersRef.current.delete(type);
      }
    };
  }, []);

  const retainChannel = useCallback((channel: string) => {
    const previousCount = subscriptionCountsRef.current.get(channel) ?? 0;
    subscriptionCountsRef.current.set(channel, previousCount + 1);

    if (previousCount === 0) {
      sendSerialized(JSON.stringify({ type: 'subscribe', channel }));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const currentCount = subscriptionCountsRef.current.get(channel) ?? 0;
      if (currentCount <= 1) {
        subscriptionCountsRef.current.delete(channel);
        sendSerialized(JSON.stringify({ type: 'unsubscribe', channel }));
      } else {
        subscriptionCountsRef.current.set(channel, currentCount - 1);
      }
    };
  }, [sendSerialized]);

  useEffect(() => {
    mountedRef.current = true;
    intentionalCloseRef.current = false;

    const clearAuthReadyTimer = () => {
      if (authReadyTimerRef.current) {
        clearTimeout(authReadyTimerRef.current);
        authReadyTimerRef.current = null;
      }
    };

    const flushQueuedMessages = (socket: WebSocket) => {
      const queuedMessages = queuedMessagesRef.current;
      queuedMessagesRef.current = [];
      for (let index = 0; index < queuedMessages.length; index += 1) {
        try {
          socket.send(queuedMessages[index]);
        } catch {
          queuedMessagesRef.current = queuedMessages
            .slice(index)
            .concat(queuedMessagesRef.current);
          socket.close();
          break;
        }
      }
    };

    const scheduleApplicationReady = (socket: WebSocket) => {
      clearAuthReadyTimer();
      authReadyTimerRef.current = setTimeout(() => {
        authReadyTimerRef.current = null;
        if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
        applicationReadyRef.current = true;
        flushQueuedMessages(socket);
        if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) {
          for (const listener of connectionListenersRef.current) listener(true);
        }
      }, AUTH_SETTLE_DELAY_MS);
    };

    const connect = () => {
      if (!mountedRef.current || intentionalCloseRef.current) return;

      const socket = new WebSocket(getWebSocketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        if (socketRef.current !== socket || !mountedRef.current) {
          socket.close(1000, 'stale');
          return;
        }

        reconnectAttemptRef.current = 0;
        authRetryAttemptRef.current = 0;
        applicationReadyRef.current = false;

        for (const channel of subscriptionCountsRef.current.keys()) {
          socket.send(JSON.stringify({ type: 'subscribe', channel }));
        }
        scheduleApplicationReady(socket);
      };

      socket.onmessage = event => {
        try {
          const message = JSON.parse(event.data) as RealtimeMessage;
          if (!message || typeof message.type !== 'string') return;

          if (message.type === 'error' && message.message === 'No autenticado') {
            applicationReadyRef.current = false;
            clearAuthReadyTimer();
            if (!authRetryTimerRef.current) {
              const delay = Math.min(
                INITIAL_AUTH_RETRY_DELAY_MS * 2 ** authRetryAttemptRef.current,
                MAX_AUTH_RETRY_DELAY_MS,
              );
              authRetryAttemptRef.current += 1;
              authRetryTimerRef.current = setTimeout(() => {
                authRetryTimerRef.current = null;
                if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
                for (const channel of subscriptionCountsRef.current.keys()) {
                  try {
                    socket.send(JSON.stringify({ type: 'subscribe', channel }));
                  } catch {
                    socket.close();
                    break;
                  }
                }
                scheduleApplicationReady(socket);
              }, delay);
            }
            return;
          }

          const listeners = listenersRef.current.get(message.type);
          if (!listeners) return;

          for (const listener of [...listeners]) {
            try {
              const result = listener(message);
              if (result instanceof Promise) {
                result.catch(error => console.error('Realtime message handler error', error));
              }
            } catch (error) {
              console.error('Realtime message handler error', error);
            }
          }
        } catch (error) {
          console.error('Realtime message parse error', error);
        }
      };

      socket.onerror = () => {
        socket.close();
      };

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        applicationReadyRef.current = false;
        for (const listener of connectionListenersRef.current) listener(false);
        clearAuthReadyTimer();
        if (authRetryTimerRef.current) {
          clearTimeout(authRetryTimerRef.current);
          authRetryTimerRef.current = null;
        }
        if (!mountedRef.current || intentionalCloseRef.current) return;

        const delay = Math.min(
          INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttemptRef.current
            + Math.random() * RECONNECT_JITTER_MS,
          MAX_RECONNECT_DELAY_MS,
        );
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      mountedRef.current = false;
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (authRetryTimerRef.current) {
        clearTimeout(authRetryTimerRef.current);
        authRetryTimerRef.current = null;
      }
      clearAuthReadyTimer();
      applicationReadyRef.current = false;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close(1000, 'unmount');
      }
      queuedMessagesRef.current = [];
    };
  }, []);

  const value = useMemo<RealtimeTransport>(() => ({
    send,
    sendIfReady,
    addConnectionListener,
    addMessageListener,
    retainChannel,
  }), [addConnectionListener, addMessageListener, retainChannel, send, sendIfReady]);

  return (
    <RealtimeTransportContext.Provider value={value}>
      {children}
    </RealtimeTransportContext.Provider>
  );
}

export function useRealtimeTransport(): RealtimeTransport {
  const transport = useContext(RealtimeTransportContext);
  if (!transport) {
    throw new Error('useRealtimeTransport must be used within RealtimeTransportProvider');
  }
  return transport;
}

export function useRealtimeMessages(
  types: readonly string[],
  handler: RealtimeMessageHandler,
): void {
  const { addMessageListener } = useRealtimeTransport();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const typesKey = types.join('\u0000');

  useEffect(
    () => addMessageListener(types, message => handlerRef.current(message)),
    [addMessageListener, typesKey],
  );
}

export function useRealtimeChannels(channelIds: readonly number[]): void {
  const { retainChannel } = useRealtimeTransport();
  const retainedChannelsRef = useRef<Map<number, () => void>>(new Map());
  const channelKey = [...new Set(channelIds)].sort((a, b) => a - b).join(',');

  useEffect(() => {
    const desiredChannels = new Set(channelIds);

    for (const [channelId, release] of retainedChannelsRef.current) {
      if (!desiredChannels.has(channelId)) {
        release();
        retainedChannelsRef.current.delete(channelId);
      }
    }

    for (const channelId of desiredChannels) {
      if (!retainedChannelsRef.current.has(channelId)) {
        retainedChannelsRef.current.set(
          channelId,
          retainChannel(`channel:${channelId}`),
        );
      }
    }
  }, [channelKey, retainChannel]);

  useEffect(() => () => {
    for (const release of retainedChannelsRef.current.values()) release();
    retainedChannelsRef.current.clear();
  }, []);
}