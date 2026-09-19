import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useRealtimeMessages,
  useRealtimeTransport,
} from '@/providers/realtime-transport';

const DM_MESSAGE_TYPES = [
  'dm_message',
  'dm_message_delete',
  'dm_typing:start',
  'dm_typing:stop',
] as const;

export function useDmWebSocket(activeDmUserId?: number | null) {
  const queryClient = useQueryClient();
  const { send } = useRealtimeTransport();
  const [dmTypingUsers, setDmTypingUsers] = useState<Set<number>>(new Set());
  const activeDmUserIdRef = useRef(activeDmUserId);
  activeDmUserIdRef.current = activeDmUserId;

  useEffect(() => {
    setDmTypingUsers(new Set());
  }, [activeDmUserId]);

  const handleMessage = useCallback((payload: any) => {
    switch (payload.type) {
      case 'dm_message': {
        const msg = payload.data;
        queryClient.setQueriesData(
          {
            predicate: query =>
              typeof query.queryKey[0] === 'string'
              && (query.queryKey[0] as string).startsWith('/api/dms/')
              && !(query.queryKey[0] as string).includes('/read'),
          },
          (old: any) => {
            if (!Array.isArray(old)) return old;
            if (old.some((message: any) => message.id === msg.id)) return old;
            const first = old[0];
            if (first) {
              const isRelevant =
                (msg.senderId === first.senderId && msg.recipientId === first.recipientId)
                || (msg.senderId === first.recipientId && msg.recipientId === first.senderId);
              if (!isRelevant) return old;
            }
            return [...old, msg];
          },
        );
        queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === '/api/dms' });
        break;
      }

      case 'dm_message_delete': {
        const msg = payload.data;
        queryClient.setQueriesData(
          {
            predicate: query =>
              typeof query.queryKey[0] === 'string'
              && (query.queryKey[0] as string).startsWith('/api/dms/'),
          },
          (old: any) => {
            if (!Array.isArray(old)) return old;
            return old.map((message: any) =>
              message.id === msg.id
                ? { ...message, deletedAt: msg.deletedAt, content: '[mensaje eliminado]' }
                : message,
            );
          },
        );
        queryClient.invalidateQueries({ predicate: query => query.queryKey[0] === '/api/dms' });
        break;
      }

      case 'dm_typing:start': {
        const { userId } = payload.data;
        if (activeDmUserIdRef.current === userId) {
          setDmTypingUsers(prev => new Set(prev).add(userId));
        }
        break;
      }

      case 'dm_typing:stop': {
        const { userId } = payload.data;
        setDmTypingUsers(prev => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
        break;
      }
    }
  }, [queryClient]);

  useRealtimeMessages(DM_MESSAGE_TYPES, handleMessage);

  const sendDmTypingStart = useCallback((recipientId: number) => {
    send({ type: 'dm_typing:start', recipientId });
  }, [send]);

  const sendDmTypingStop = useCallback((recipientId: number) => {
    send({ type: 'dm_typing:stop', recipientId });
  }, [send]);

  return { dmTypingUsers, sendDmTypingStart, sendDmTypingStop };
}