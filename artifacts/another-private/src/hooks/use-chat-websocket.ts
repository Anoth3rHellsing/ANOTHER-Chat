import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getListMessagesQueryKey } from '@workspace/api-client-react';

type WSEvent = 
  | { type: "message:new", data: any }
  | { type: "message:edit", data: any }
  | { type: "message:delete", data: { id: number, channelId: number } }
  | { type: "typing:start", data: { userId: number, channelId: number } }
  | { type: "typing:stop", data: { userId: number, channelId: number } }
  | { type: "user:status", data: { userId: number, status: any } };

export function useChatWebSocket(channelId?: number | null) {
  const queryClient = useQueryClient();
  const ws = useRef<WebSocket | null>(null);
  const [typingUsers, setTypingUsers] = useState<Set<number>>(new Set());

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wsUrl = `${protocol}//${host}${baseUrl}/ws`;
    
    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      if (channelId) {
        ws.current?.send(JSON.stringify({ type: "subscribe", channel: `channel:${channelId}` }));
      }
    };

    ws.current.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WSEvent;
        
        switch (payload.type) {
          case 'message:new':
            if (channelId === payload.data.channelId) {
              queryClient.setQueryData(getListMessagesQueryKey({ channelId }), (old: any) => {
                if (!old) return [payload.data];
                if (old.some((m: any) => m.id === payload.data.id)) return old;
                return [...old, payload.data];
              });
            }
            break;
          case 'message:edit':
            if (channelId === payload.data.channelId) {
              queryClient.setQueryData(getListMessagesQueryKey({ channelId }), (old: any) => {
                if (!old) return old;
                return old.map((m: any) => m.id === payload.data.id ? payload.data : m);
              });
            }
            break;
          case 'message:delete':
            if (channelId === payload.data.channelId) {
              queryClient.setQueryData(getListMessagesQueryKey({ channelId }), (old: any) => {
                if (!old) return old;
                return old.map((m: any) => m.id === payload.data.id ? { ...m, deletedAt: new Date().toISOString() } : m);
              });
            }
            break;
          case 'typing:start':
            if (channelId === payload.data.channelId) {
              setTypingUsers(prev => {
                const next = new Set(prev);
                next.add(payload.data.userId);
                return next;
              });
            }
            break;
          case 'typing:stop':
            if (channelId === payload.data.channelId) {
              setTypingUsers(prev => {
                const next = new Set(prev);
                next.delete(payload.data.userId);
                return next;
              });
            }
            break;
          case 'user:status':
            // Invalidate server members
            queryClient.invalidateQueries({
              predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('/api/servers') && (query.queryKey[0] as string).endsWith('/members')
            });
            break;
        }
      } catch (err) {
        console.error("WS parse error", err);
      }
    };

    return () => {
      ws.current?.close();
      setTypingUsers(new Set());
    };
  }, [channelId, queryClient]);

  const sendTypingStart = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN && channelId) {
      ws.current.send(JSON.stringify({ type: "typing:start", channelId }));
    }
  }, [channelId]);

  const sendTypingStop = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN && channelId) {
      ws.current.send(JSON.stringify({ type: "typing:stop", channelId }));
    }
  }, [channelId]);

  return { typingUsers, sendTypingStart, sendTypingStop };
}
