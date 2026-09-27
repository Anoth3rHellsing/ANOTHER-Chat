import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getGetVoiceMembersQueryKey, getListChannelsQueryKey, getListCategoriesQueryKey } from '@workspace/api-client-react';
import {
  useRealtimeChannels,
  useRealtimeMessages,
  useRealtimeTransport,
} from '@/providers/realtime-transport';
import { updateChannelReactions, type MessageReaction } from '@/lib/reactions';

type WSEvent =
  | { type: 'message:new', data: any }
  | { type: 'message:edit', data: any }
  | { type: 'message:delete', data: { id: number, channelId: number } }
  | { type: 'message_reaction_update', data: { messageId: number, channelId?: number, reactions: MessageReaction[] } }
  | { type: 'typing:start', data: { userId: number, channelId: number } }
  | { type: 'typing:stop', data: { userId: number, channelId: number } }
  | { type: 'user:status', data: { userId: number, status: any } }
  | { type: 'voice:member_join', data: { channelId: number, member: any } }
  | { type: 'voice:member_leave', data: { channelId: number, userId: number } }
  | { type: 'channels:changed', data: { serverId: number } }
  | { type: 'mention:new', data: { messageId: number, channelId: number, serverId: number, authorName: string, preview: string } };

const CHAT_MESSAGE_TYPES = [
  'message:new',
  'message:edit',
  'message:delete',
  'message_reaction_update',
  'typing:start',
  'typing:stop',
  'voice:member_join',
  'voice:member_leave',
  'user:status',
  'mention:new',
  'channels:changed',
] as const;

function isChannelMessagesKey(queryKey: readonly unknown[], channelId: number): boolean {
  return queryKey.length >= 1 && queryKey[0] === `/api/channels/${channelId}/messages`;
}

export function useChatWebSocket(
  channelId?: number | null,
  allChannelIds?: number[],
  onMention?: (data: { messageId: number, channelId: number, serverId: number, authorName: string, preview: string }) => void,
  currentUserId?: number,
  channelVisibleFocused = true,
) {
  const queryClient = useQueryClient();
  const { send } = useRealtimeTransport();
  const [typingUsers, setTypingUsers] = useState<Set<number>>(new Set());
  const [unreadCounts, setUnreadCounts] = useState<Map<number, number>>(new Map());
  const activeChannelIdRef = useRef(channelId);
  const onMentionRef = useRef(onMention);
  const currentUserIdRef = useRef(currentUserId);
  const channelVisibleFocusedRef = useRef(channelVisibleFocused);

  activeChannelIdRef.current = channelId;
  onMentionRef.current = onMention;
  currentUserIdRef.current = currentUserId;
  channelVisibleFocusedRef.current = channelVisibleFocused;
  useRealtimeChannels(allChannelIds ?? []);

  useEffect(() => {
    setTypingUsers(new Set());
  }, [channelId]);

  const clearUnread = useCallback((id: number) => {
    setUnreadCounts(prev => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleMessage = useCallback((payload: WSEvent) => {
    const activeChannelId = activeChannelIdRef.current;

    switch (payload.type) {
      case 'message:new':
        if (activeChannelId && activeChannelId === payload.data.channelId) {
          queryClient.setQueriesData(
            { predicate: q => isChannelMessagesKey(q.queryKey, activeChannelId) },
            (old: any) => {
              if (!old) return [payload.data];
              if (old.some((message: any) => message.id === payload.data.id)) return old;
              return [...old, payload.data];
            },
          );
        }
        if (payload.data.channelId && payload.data.userId !== currentUserIdRef.current &&
            (payload.data.channelId !== activeChannelId || !channelVisibleFocusedRef.current)) {
          setUnreadCounts(prev => {
            const next = new Map(prev);
            next.set(payload.data.channelId, (next.get(payload.data.channelId) ?? 0) + 1);
            return next;
          });
        }
        break;

      case 'message:edit':
        if (activeChannelId && activeChannelId === payload.data.channelId) {
          queryClient.setQueriesData(
            { predicate: q => isChannelMessagesKey(q.queryKey, activeChannelId) },
            (old: any) => {
              if (!old) return old;
              return old.map((message: any) =>
                message.id === payload.data.id ? payload.data : message,
              );
            },
          );
        }
        break;

      case 'message:delete':
        if (activeChannelId && activeChannelId === payload.data.channelId) {
          queryClient.setQueriesData(
            { predicate: q => isChannelMessagesKey(q.queryKey, payload.data.channelId) },
            (old: any) => {
              if (!old) return old;
              return old.map((message: any) =>
                message.id === payload.data.id
                  ? { ...message, deletedAt: new Date().toISOString() }
                  : message,
              );
            },
          );
        }
        break;

      case 'message_reaction_update':
        if (payload.data.channelId ?? activeChannelId) {
          updateChannelReactions(
            queryClient,
            (payload.data.channelId ?? activeChannelId)!,
            payload.data.messageId,
            payload.data.reactions,
          );
        }
        break;

      case 'typing:start':
        if (activeChannelId === payload.data.channelId) {
          setTypingUsers(prev => new Set(prev).add(payload.data.userId));
        }
        break;

      case 'typing:stop':
        if (activeChannelId === payload.data.channelId) {
          setTypingUsers(prev => {
            const next = new Set(prev);
            next.delete(payload.data.userId);
            return next;
          });
        }
        break;

      case 'voice:member_join':
      case 'voice:member_leave':
        if (payload.data?.channelId) {
          queryClient.invalidateQueries({
            queryKey: getGetVoiceMembersQueryKey(payload.data.channelId),
          });
        }
        break;

      case 'user:status':
        queryClient.invalidateQueries({
          predicate: query =>
            typeof query.queryKey[0] === 'string'
            && (query.queryKey[0] as string).startsWith('/api/servers')
            && (query.queryKey[0] as string).endsWith('/members'),
        });
        break;

      case 'channels:changed':
        // El aviso no lleva nombres: se vuelve a pedir la lista, que el servidor filtra por permisos.
        if (typeof payload.data?.serverId === 'number') {
          queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey(payload.data.serverId) });
          queryClient.invalidateQueries({ queryKey: ['categories', payload.data.serverId] });
          queryClient.invalidateQueries({ queryKey: getListCategoriesQueryKey(payload.data.serverId) });
        }
        break;

      case 'mention:new':
        onMentionRef.current?.(payload.data);
        break;
    }
  }, [queryClient]);

  useRealtimeMessages(CHAT_MESSAGE_TYPES, handleMessage as (message: any) => void);

  const sendTypingStart = useCallback(() => {
    const activeChannelId = activeChannelIdRef.current;
    if (activeChannelId) send({ type: 'typing:start', channelId: activeChannelId });
  }, [send]);

  const sendTypingStop = useCallback(() => {
    const activeChannelId = activeChannelIdRef.current;
    if (activeChannelId) send({ type: 'typing:stop', channelId: activeChannelId });
  }, [send]);

  return { typingUsers, sendTypingStart, sendTypingStop, unreadCounts, clearUnread };
}