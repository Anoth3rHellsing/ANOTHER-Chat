import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ImagePlus, MessageSquare, MoreVertical, Send, Smile, Users as UsersIcon } from 'lucide-react';
import { csrfFetch } from '@workspace/api-client-react';
import { EmojiPicker, insertEmojiAtCursor, QUICK_EMOJIS } from '@/components/emoji-picker';
import { GifMessage } from '@/components/gif-message';
import { AvatarImage } from '@/components/avatar-image';
import { GifPicker } from '@/components/gif-picker';
import { ReactionIndicators } from '@/components/reaction-indicators';
import { serializeGiphyMessage } from '@/lib/giphy';
import type { MessageReaction } from '@/lib/reactions';
import { useRealtimeMessages } from '@/providers/realtime-transport';

interface DmGroupConversationProps {
  groupId: number;
  groupName: string;
  currentUserId: number;
  onBack?: () => void;
}

interface GroupMessage {
  id: number;
  groupId: number;
  userId: number;
  content: string;
  createdAt: string;
  reactions?: MessageReaction[];
  author: {
    username: string;
    displayName: string;
    avatarUrl?: string | null;
  };
}

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

async function readError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function DmGroupConversation({ groupId, groupName, currentUserId, onBack }: DmGroupConversationProps) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<number | null>(null);
  const [mobileActionsMessageId, setMobileActionsMessageId] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [reactionError, setReactionError] = useState<string | null>(null);
  const [pendingReactions, setPendingReactions] = useState<Set<string>>(new Set());
  const pendingReactionKeys = useRef(new Set<string>());
  const messagesQueryKey = ['/api/dm-groups', groupId, 'messages'];

  // Group events arrive through the authenticated unified transport; there is
  // no need to subscribe to the group's unrestricted topic.
  useRealtimeMessages(['dm_group:message', 'dm_group:reaction_update'], payload => {
    const data = payload.data as {
      groupId: number;
      messageId?: number;
      reactions?: MessageReaction[];
      id?: number;
      userId?: number;
      content?: string;
      createdAt?: string;
      author?: GroupMessage['author'];
    } | undefined;
    if (!data || data.groupId !== groupId) return;

    if (payload.type === 'dm_group:reaction_update') {
      if (typeof data.messageId !== 'number' || !Array.isArray(data.reactions)) return;
      queryClient.setQueryData<GroupMessage[]>(messagesQueryKey, previous => (
        previous?.map(item => item.id === data.messageId ? { ...item, reactions: data.reactions } : item)
      ));
      void queryClient.invalidateQueries({ queryKey: messagesQueryKey });
      return;
    }

    if (
      typeof data.id !== 'number'
      || typeof data.userId !== 'number'
      || typeof data.content !== 'string'
      || typeof data.createdAt !== 'string'
      || !data.author
    ) return;

    const incoming: GroupMessage = {
      id: data.id,
      groupId: data.groupId,
      userId: data.userId,
      content: data.content,
      createdAt: data.createdAt,
      author: data.author,
      reactions: data.reactions ?? [],
    };
    queryClient.setQueryData<GroupMessage[]>(messagesQueryKey, previous => {
      if (!previous) return previous;
      if (previous.some(item => item.id === incoming.id)) return previous;
      return [...previous, incoming];
    });
    void queryClient.invalidateQueries({ queryKey: messagesQueryKey });
  });

  const messagesQuery = useQuery<GroupMessage[]>({
    queryKey: messagesQueryKey,
    queryFn: async () => {
      const response = await fetch(`${BASE_URL}/api/dm-groups/${groupId}/messages`, {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(await readError(response, 'No se pudieron cargar los mensajes.'));
      }
      return response.json();
    },
    enabled: Number.isFinite(groupId) && groupId > 0,
  });

  const sendMessage = useMutation({
    mutationFn: async (content: string) => {
      const response = await csrfFetch(`${BASE_URL}/api/dm-groups/${groupId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        throw new Error(await readError(response, 'No se pudo enviar el mensaje.'));
      }
      return response.json() as Promise<GroupMessage>;
    },
    onSuccess: async (_data, content) => {
      if (message.trim() === content) setMessage('');
      setSendError(null);
      setEmojiPickerOpen(false);
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey });
    },
    onError: (error: Error) => setSendError(error.message || 'No se pudo enviar el mensaje.'),
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = message.trim();
    if (!content || sendMessage.isPending) return;
    setSendError(null);
    sendMessage.mutate(content);
  };

  const toggleReaction = async (messageId: number, emoji: string) => {
    const pendingKey = `${messageId}:${emoji}`;
    if (pendingReactionKeys.current.has(pendingKey)) return;
    pendingReactionKeys.current.add(pendingKey);
    setPendingReactions(previous => new Set(previous).add(pendingKey));
    setReactionError(null);

    try {
      const response = await csrfFetch(`${BASE_URL}/api/dm-groups/${groupId}/messages/${messageId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ emoji }),
      });
      if (!response.ok) {
        throw new Error(await readError(response, 'No se pudo actualizar la reacción.'));
      }
      const reactions = await response.json() as MessageReaction[];
      queryClient.setQueryData<GroupMessage[]>(messagesQueryKey, previous => previous?.map(message => (
        message.id === messageId ? { ...message, reactions } : message
      )));
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey });
    } catch (error) {
      setReactionError(error instanceof Error ? error.message : 'No se pudo actualizar la reacción.');
    } finally {
      pendingReactionKeys.current.delete(pendingKey);
      setPendingReactions(previous => {
        const next = new Set(previous);
        next.delete(pendingKey);
        return next;
      });
    }
  };

  const messages = messagesQuery.data ?? [];

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="z-10 flex h-12 flex-shrink-0 items-center gap-3 border-b border-border bg-card/30 px-4 backdrop-blur-sm">
        <button type="button" onClick={onBack} className="md:hidden -ml-1 p-1 text-muted-foreground hover:text-foreground" aria-label="Volver a conversaciones">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary">
          <UsersIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="truncate font-semibold text-foreground">{groupName}</div>
          <div className="text-xs font-mono text-muted-foreground">Conversación grupal</div>
        </div>
      </div>

      <div className="flex-1 space-y-0 overflow-y-auto p-4">
        {messagesQuery.isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <MessageSquare className="h-4 w-4" />
            Cargando mensajes…
          </div>
        ) : messagesQuery.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <p>{messagesQuery.error instanceof Error ? messagesQuery.error.message : 'No se pudieron cargar los mensajes.'}</p>
            <button
              type="button"
              onClick={() => messagesQuery.refetch()}
              className="text-primary transition-colors hover:text-primary/80"
            >
              Intentar de nuevo
            </button>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageSquare className="h-12 w-12 opacity-20" />
            <p className="text-sm">Aún no hay mensajes. ¡Inicia la conversación!</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const previous = messages[index - 1];
            const isFirst = !previous
              || previous.userId !== msg.userId
              || new Date(msg.createdAt).getTime() - new Date(previous.createdAt).getTime() > 300_000;
            const isOwn = msg.userId === currentUserId;

            return (
              <div
                key={msg.id}
                className={`group -mx-2 flex gap-4 rounded-lg px-2 transition-colors hover:bg-muted/20 ${isFirst ? 'mt-3 pt-0.5' : 'mt-0.5'}`}
              >
                {isFirst ? (
                  <div className="mt-0.5 h-10 w-10 flex-shrink-0 overflow-hidden rounded-full bg-secondary">
                    {msg.author?.avatarUrl
                      ? <AvatarImage url={msg.author.avatarUrl} />
                      : <UsersIcon className="m-2.5 h-5 w-5 text-muted-foreground" />}
                  </div>
                ) : (
                  <div className="w-10 flex-shrink-0 pt-1 text-center font-mono text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100">
                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
                <div className="min-w-0 flex-1 pb-1">
                  {isFirst && (
                    <div className="mb-0.5 flex flex-wrap items-baseline gap-2">
                      <span className={`font-medium ${isOwn ? 'text-primary' : 'text-foreground'}`}>
                        {msg.author?.displayName ?? 'Usuario'}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {new Date(msg.createdAt).toLocaleString([], {
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  )}
                  <div className="relative">
                    <div className="text-sm leading-normal text-foreground/90 pr-12 md:pr-0">
                      <GifMessage content={msg.content} />
                    </div>
                    <button type="button" aria-label="Más acciones del mensaje" aria-expanded={mobileActionsMessageId === msg.id} onClick={() => setMobileActionsMessageId(mobileActionsMessageId === msg.id ? null : msg.id)} className="absolute right-0 top-0 z-10 flex h-11 w-11 items-center justify-center rounded-md border border-border bg-card text-muted-foreground md:hidden"><MoreVertical className="h-4 w-4" /></button>
                    <div className={`${mobileActionsMessageId === msg.id ? 'flex' : 'hidden'} md:flex absolute top-11 md:-top-2 right-0 z-10 items-center gap-1 rounded-md border border-border bg-card p-1 shadow-lg [&_button]:min-h-11 [&_button]:min-w-11 md:[&_button]:min-h-0 md:[&_button]:min-w-0 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100`}>
                      <div className="flex items-center gap-0.5" role="group" aria-label="Reacciones rápidas">
                        {QUICK_EMOJIS.slice(0, 4).map(emoji => (
                          <button
                            key={emoji}
                            type="button"
                            onClick={() => void toggleReaction(msg.id, emoji)}
                            disabled={pendingReactions.has(`${msg.id}:${emoji}`)}
                            title={`Reaccionar con ${emoji}`}
                            aria-label={`Reaccionar con ${emoji}`}
                            className="rounded p-1 text-sm transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setReactionPickerMessageId(current => current === msg.id ? null : msg.id)}
                        title="Más emojis"
                        aria-label="Elegir reacción"
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <Smile className="h-3.5 w-3.5" />
                      </button>
                      {reactionPickerMessageId === msg.id && (
                        <EmojiPicker
                          onSelect={emoji => { void toggleReaction(msg.id, emoji); }}
                          onClose={() => setReactionPickerMessageId(null)}
                        />
                      )}
                    </div>
                    <ReactionIndicators
                      reactions={msg.reactions}
                      currentUserId={currentUserId}
                      onToggle={emoji => { void toggleReaction(msg.id, emoji); }}
                      isPending={emoji => pendingReactions.has(`${msg.id}:${emoji}`)}
                      getName={userId => messages.find(candidate => candidate.userId === userId)?.author?.displayName ?? (userId === currentUserId ? 'Tú' : `Usuario ${userId}`)}
                    />
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="p-4 pt-0">
        {reactionError && (
          <p role="alert" className="mb-2 px-2 text-xs text-destructive">{reactionError}</p>
        )}
        {sendError && (
          <p role="alert" className="mb-2 px-2 text-xs text-destructive">{sendError}</p>
        )}
        <form onSubmit={handleSubmit} className="relative flex items-center rounded-xl border border-border bg-card">
          <button
            type="button"
            aria-label="Insertar emoji"
            title="Emoji"
            onClick={() => {
              setGifPickerOpen(false);
              setEmojiPickerOpen(open => !open);
            }}
            className="p-3 text-muted-foreground transition-colors hover:text-primary"
          >
            <Smile className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label="Insertar GIF"
            title="GIF"
            onClick={() => {
              setEmojiPickerOpen(false);
              setGifPickerOpen(open => !open);
            }}
            disabled={sendMessage.isPending}
            className="p-3 text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
          >
            <ImagePlus className="h-5 w-5" />
          </button>
          <input
            ref={inputRef}
            type="text"
            value={message}
            onChange={event => setMessage(event.target.value)}
            onFocus={() => setSendError(null)}
            placeholder={`Mensaje a ${groupName}...`}
            className="flex-1 bg-transparent px-1 py-3.5 font-sans text-foreground placeholder:text-muted-foreground focus:outline-none"
            disabled={sendMessage.isPending}
          />
          <button
            type="submit"
            aria-label="Enviar mensaje"
            disabled={!message.trim() || sendMessage.isPending}
            className="p-3 text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
          >
            <Send className="h-5 w-5" />
          </button>
          {emojiPickerOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-2">
              <EmojiPicker
                onSelect={emoji => insertEmojiAtCursor(inputRef.current, message, emoji, setMessage)}
                onClose={() => setEmojiPickerOpen(false)}
              />
            </div>
          )}
          {gifPickerOpen && (
            <GifPicker
              onSelect={gif => {
                setGifPickerOpen(false);
                setSendError(null);
                sendMessage.mutate(serializeGiphyMessage(gif.url));
              }}
              onClose={() => setGifPickerOpen(false)}
            />
          )}
        </form>
      </div>
    </div>
  );
}