import type { QueryClient } from '@tanstack/react-query';

export interface MessageReaction {
  emoji: string;
  count: number;
  userIds: number[];
}

function replaceReactions(old: unknown, messageId: number, reactions: MessageReaction[]): unknown {
  if (!Array.isArray(old)) return old;
  return old.map(message => message.id === messageId ? { ...message, reactions } : message);
}

export function updateChannelReactions(
  queryClient: QueryClient,
  channelId: number,
  messageId: number,
  reactions: MessageReaction[],
) {
  queryClient.setQueriesData(
    { predicate: query => query.queryKey[0] === `/api/channels/${channelId}/messages` },
    old => replaceReactions(old, messageId, reactions),
  );
  // A newer mutation can commit before an older request broadcasts its snapshot.
  // Refetching the authoritative state also prevents an in-flight history load
  // from overwriting a more recent WebSocket update.
  void queryClient.invalidateQueries({
    predicate: query => query.queryKey[0] === `/api/channels/${channelId}/messages`,
  });
}

export function updateDmReactions(queryClient: QueryClient, messageId: number, reactions: MessageReaction[]) {
  queryClient.setQueriesData(
    {
      predicate: query => typeof query.queryKey[0] === 'string'
        && /^\/api\/dms\/\d+$/.test(query.queryKey[0]),
    },
    old => replaceReactions(old, messageId, reactions),
  );
  void queryClient.invalidateQueries({
    predicate: query => typeof query.queryKey[0] === 'string'
      && /^\/api\/dms\/\d+$/.test(query.queryKey[0]),
  });
}