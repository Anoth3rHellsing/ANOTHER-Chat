import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetVoiceMembersQueryKey } from '@workspace/api-client-react';

type WSEvent = 
  | { type: "message:new", data: any }
  | { type: "message:edit", data: any }
  | { type: "message:delete", data: { id: number, channelId: number } }
  | { type: "message_reaction_update", data: { messageId: number, reactions: any[] } }
  | { type: "typing:start", data: { userId: number, channelId: number } }
  | { type: "typing:stop", data: { userId: number, channelId: number } }
  | { type: "user:status", data: { userId: number, status: any } }
  | { type: "voice:member_join", data: { channelId: number, member: any } }
  | { type: "voice:member_leave", data: { channelId: number, userId: number } };

/** Returns true when a React Query key belongs to the messages list for a given channel. */
function isChannelMessagesKey(queryKey: readonly unknown[], channelId: number): boolean {
  return (
    queryKey.length >= 1 &&
    queryKey[0] === `/api/channels/${channelId}/messages`
  );
}

/**
 * useChatWebSocket — manages one WS connection for a channel.
 * 
 * @param channelId       The primary active channel (for typing, message updates).
 * @param allChannelIds   All channels to subscribe to for unread notifications.
 *                        When a message:new arrives for a channel other than channelId,
 *                        the unreadCounts map is updated.
 */
export function useChatWebSocket(
  channelId?: number | null,
  allChannelIds?: number[],
) {
  const queryClient = useQueryClient();
  const ws = useRef<WebSocket | null>(null);
  const [typingUsers, setTypingUsers] = useState<Set<number>>(new Set());
  const [unreadCounts, setUnreadCounts] = useState<Map<number, number>>(new Map());

  const clearUnread = useCallback((id: number) => {
    setUnreadCounts(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

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
      // Subscribe to all other channels for notification purposes
      if (allChannelIds) {
        for (const cid of allChannelIds) {
          if (cid !== channelId) {
            ws.current?.send(JSON.stringify({ type: "subscribe", channel: `channel:${cid}` }));
          }
        }
      }
    };

    ws.current.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WSEvent;

        switch (payload.type) {
          case 'message:new':
            if (channelId && channelId === payload.data.channelId) {
              queryClient.setQueriesData(
                { predicate: (q) => isChannelMessagesKey(q.queryKey, channelId) },
                (old: any) => {
                  if (!old) return [payload.data];
                  if (old.some((m: any) => m.id === payload.data.id)) return old;
                  return [...old, payload.data];
                }
              );
            } else if (payload.data.channelId && payload.data.channelId !== channelId) {
              // Message in a non-active channel — increment unread
              setUnreadCounts(prev => {
                const next = new Map(prev);
                const current = next.get(payload.data.channelId) ?? 0;
                next.set(payload.data.channelId, current + 1);
                return next;
              });
            }
            break;

          case 'message:edit':
            if (channelId && channelId === payload.data.channelId) {
              queryClient.setQueriesData(
                { predicate: (q) => isChannelMessagesKey(q.queryKey, channelId) },
                (old: any) => {
                  if (!old) return old;
                  return old.map((m: any) => m.id === payload.data.id ? payload.data : m);
                }
              );
            }
            break;

          case 'message:delete':
            if (channelId && channelId === payload.data.channelId) {
              queryClient.setQueriesData(
                { predicate: (q) => isChannelMessagesKey(q.queryKey, payload.data.channelId) },
                (old: any) => {
                  if (!old) return old;
                  return old.map((m: any) =>
                    m.id === payload.data.id ? { ...m, deletedAt: new Date().toISOString() } : m
                  );
                }
              );
            }
            break;

          case 'message_reaction_update':
            if (channelId) {
              queryClient.setQueriesData(
                { predicate: (q) => isChannelMessagesKey(q.queryKey, channelId) },
                (old: any) => {
                  if (!old) return old;
                  return old.map((m: any) =>
                    m.id === payload.data.messageId
                      ? { ...m, reactions: payload.data.reactions }
                      : m
                  );
                }
              );
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

          case 'voice:member_join':
            if (payload.data?.channelId) {
              queryClient.invalidateQueries({ queryKey: getGetVoiceMembersQueryKey(payload.data.channelId) });
            }
            break;

          case 'voice:member_leave':
            if (payload.data?.channelId) {
              queryClient.invalidateQueries({ queryKey: getGetVoiceMembersQueryKey(payload.data.channelId) });
            }
            break;

          case 'user:status':
            queryClient.invalidateQueries({
              predicate: (query) =>
                typeof query.queryKey[0] === 'string' &&
                (query.queryKey[0] as string).startsWith('/api/servers') &&
                (query.queryKey[0] as string).endsWith('/members')
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
  }, [channelId, allChannelIds?.join(','), queryClient]);

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

  return { typingUsers, sendTypingStart, sendTypingStop, unreadCounts, clearUnread };
}
