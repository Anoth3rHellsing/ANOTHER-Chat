import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/** DM-specific WebSocket hook. Manages a dedicated connection for DM real-time events.
 *  Pass `activeDmUserId` to filter typing indicators for the currently open conversation.
 */
export function useDmWebSocket(activeDmUserId?: number | null) {
  const queryClient = useQueryClient();
  const ws = useRef<WebSocket | null>(null);
  const [dmTypingUsers, setDmTypingUsers] = useState<Set<number>>(new Set());

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const wsUrl = `${protocol}//${host}${baseUrl}/ws`;

    ws.current = new WebSocket(wsUrl);

    ws.current.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        switch (payload.type) {
          case 'dm_message': {
            const msg = payload.data;
            // Update DM history cache for the conversation
            const otherId = msg.senderId === msg.recipientId ? msg.senderId
              : activeDmUserId ?? null;
            // We update any cached DM history that contains either participant
            queryClient.setQueriesData(
              { predicate: q => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('/api/dms/') && !(q.queryKey[0] as string).includes('/read') },
              (old: any) => {
                if (!Array.isArray(old)) return old;
                if (old.some((m: any) => m.id === msg.id)) return old;
                // Only add to history caches that match this conversation
                const first = old[0];
                if (first) {
                  const partnerId = first.senderId === msg.senderId ? first.recipientId : first.senderId;
                  const isRelevant =
                    (msg.senderId === first.senderId && msg.recipientId === first.recipientId) ||
                    (msg.senderId === first.recipientId && msg.recipientId === first.senderId);
                  if (!isRelevant) return old;
                }
                return [...old, msg];
              }
            );
            // Invalidate conversations list so unread counts update
            queryClient.invalidateQueries({ predicate: q => q.queryKey[0] === '/api/dms' });
            break;
          }

          case 'dm_message_delete': {
            const msg = payload.data;
            queryClient.setQueriesData(
              { predicate: q => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('/api/dms/') },
              (old: any) => {
                if (!Array.isArray(old)) return old;
                return old.map((m: any) => m.id === msg.id ? { ...m, deletedAt: msg.deletedAt, content: '[mensaje eliminado]' } : m);
              }
            );
            queryClient.invalidateQueries({ predicate: q => q.queryKey[0] === '/api/dms' });
            break;
          }

          case 'dm_typing:start': {
            const { userId } = payload.data;
            if (activeDmUserId === userId) {
              setDmTypingUsers(prev => { const n = new Set(prev); n.add(userId); return n; });
            }
            break;
          }

          case 'dm_typing:stop': {
            const { userId } = payload.data;
            setDmTypingUsers(prev => { const n = new Set(prev); n.delete(userId); return n; });
            break;
          }
        }
      } catch (err) {
        console.error('DM WS parse error', err);
      }
    };

    return () => {
      ws.current?.close();
      setDmTypingUsers(new Set());
    };
  }, [activeDmUserId, queryClient]);

  const sendDmTypingStart = useCallback((recipientId: number) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'dm_typing:start', recipientId }));
    }
  }, []);

  const sendDmTypingStop = useCallback((recipientId: number) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'dm_typing:stop', recipientId }));
    }
  }, []);

  return { dmTypingUsers, sendDmTypingStart, sendDmTypingStop };
}
