import { useEffect, useRef, useState } from 'react';
import { useRealtimeMessages } from '@/providers/realtime-transport';
import { playMessageSound } from '@/lib/voice-sounds';
import { isNotificationsMuted, shouldAlertForMessage, type MessageKind } from '@/lib/notification-rules';
import type { NotificationSettings } from '@/lib/notification-settings';

type Destination =
  | { kind: 'channel'; serverId: number; channelId: number }
  | { kind: 'dm'; userId: number }
  | { kind: 'group'; groupId: number };

interface Options {
  userId: number | undefined;
  settings: NotificationSettings;
  volume: number;
  channels: Map<number, { serverId: number; name: string; serverName: string }>;
  dmNames: Map<number, string>;
  groupNames: Map<number, string>;
  active: Destination | null;
  navigate: (destination: Destination) => void;
}

interface Incoming {
  id: number;
  key: string;
  kind: MessageKind;
  destination: Destination;
  name: string;
  origin: string;
  content: string;
  own: boolean;
  mentioned?: boolean;
}

const EVENT_TYPES = ['message:new', 'mention:new', 'dm_message', 'dm_group:message'] as const;

function sameDestination(a: Destination | null, b: Destination): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'channel' && b.kind === 'channel') return a.channelId === b.channelId;
  if (a.kind === 'dm' && b.kind === 'dm') return a.userId === b.userId;
  return a.kind === 'group' && b.kind === 'group' && a.groupId === b.groupId;
}

function destinationKey(destination: Destination): string {
  if (destination.kind === 'channel') return `channel:${destination.channelId}`;
  if (destination.kind === 'dm') return `dm:${destination.userId}`;
  return `group:${destination.groupId}`;
}

function isFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function useMessageNotifications(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [mentionCounts, setMentionCounts] = useState<Map<number, number>>(new Map());
  const [groupUnread, setGroupUnread] = useState<Map<number, number>>(new Map());
  const mentionedIds = useRef(new Set<string>());
  const alertedIds = useRef(new Set<string>());
  const pending = useRef(new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>());
  const lastSound = useRef(new Map<string, number>());
  const notifications = useRef(new Map<string, Notification>());

  useEffect(() => {
    const pendingMap = pending.current;
    const shown = notifications.current;
    return () => {
      for (const item of pendingMap.values()) clearTimeout(item.timer);
      pendingMap.clear();
      for (const item of shown.values()) item.close();
      shown.clear();
      alertedIds.current.clear();
      mentionedIds.current.clear();
      lastSound.current.clear();
      setMentionCounts(new Map());
      setGroupUnread(new Map());
    };
  }, [options.userId]);

  useRealtimeMessages(EVENT_TYPES, payload => {
    const current = optionsRef.current;
    if (!current.userId) return;
    const data = payload.data;
    if (!data || !Number.isSafeInteger(Number(data.id ?? data.messageId))) return;
    const id = Number(data.id ?? data.messageId);
    let incoming: Incoming;
    if (payload.type === 'mention:new' || payload.type === 'message:new') {
      const channelId = Number(data.channelId);
      const channel = current.channels.get(channelId);
      const serverId = Number(data.serverId ?? channel?.serverId);
      if (!Number.isSafeInteger(channelId) || !Number.isSafeInteger(serverId)) return;
      const destination: Destination = { kind: 'channel', serverId, channelId };
      incoming = {
        id, key: `channel:${id}`, kind: 'channel', destination,
        name: payload.type === 'mention:new' ? String(data.authorName ?? 'Usuario') : String(data.author?.displayName ?? 'Usuario'),
        origin: `${channel?.serverName ?? 'Servidor'} · #${channel?.name ?? `canal ${channelId}`}`,
        content: String(payload.type === 'mention:new' ? data.preview ?? '' : data.content ?? ''),
        own: payload.type === 'message:new' && Number(data.userId) === current.userId,
        mentioned: payload.type === 'mention:new',
      };
      if (payload.type === 'mention:new' && !mentionedIds.current.has(incoming.key)) {
        mentionedIds.current.add(incoming.key);
        if (mentionedIds.current.size > 1000) mentionedIds.current.clear();
        if (!sameDestination(current.active, destination) || !isFocused()) {
          setMentionCounts(previous => new Map(previous).set(channelId, (previous.get(channelId) ?? 0) + 1));
        }
      }
    } else if (payload.type === 'dm_message') {
      const senderId = Number(data.senderId);
      const otherId = senderId === current.userId ? Number(data.recipientId) : senderId;
      if (!Number.isSafeInteger(otherId)) return;
      const destination: Destination = { kind: 'dm', userId: otherId };
      incoming = {
        id, key: `dm:${id}`, kind: 'dm', destination,
        name: String(data.sender?.displayName ?? current.dmNames.get(otherId) ?? 'Usuario'),
        origin: 'Mensaje directo', content: String(data.content ?? ''),
        own: senderId === current.userId,
      };
    } else if (payload.type === 'dm_group:message') {
      const groupId = Number(data.groupId);
      if (!Number.isSafeInteger(groupId)) return;
      const destination: Destination = { kind: 'group', groupId };
      incoming = {
        id, key: `group:${groupId}:${id}`, kind: 'group', destination,
        name: String(data.author?.displayName ?? 'Usuario'),
        origin: current.groupNames.get(groupId) ?? `Grupo ${groupId}`,
        content: String(data.content ?? ''), own: Number(data.userId) === current.userId,
      };
      if (!incoming.own && (!sameDestination(current.active, destination) || !isFocused())) {
        setGroupUnread(previous => new Map(previous).set(groupId, (previous.get(groupId) ?? 0) + 1));
      }
    } else return;

    const viewingFocused = isFocused() && sameDestination(current.active, incoming.destination);
    if (!shouldAlertForMessage({
      settings: current.settings, kind: incoming.kind, own: incoming.own, viewingFocused,
      mentioned: incoming.mentioned,
      serverId: incoming.destination.kind === 'channel' ? incoming.destination.serverId : undefined,
      channelId: incoming.destination.kind === 'channel' ? incoming.destination.channelId : undefined,
    })) return;
    if (alertedIds.current.has(incoming.key)) return;
    alertedIds.current.add(incoming.key);
    if (alertedIds.current.size > 1000) alertedIds.current.clear();

    const key = destinationKey(incoming.destination);
    const existing = pending.current.get(key);
    if (existing) clearTimeout(existing.timer);
    const count = (existing?.count ?? 0) + 1;
    const timer = setTimeout(() => {
      pending.current.delete(key);
      const latest = optionsRef.current;
      if (latest.userId !== current.userId || isNotificationsMuted(latest.settings) ||
          (isFocused() && sameDestination(latest.active, incoming.destination))) return;
      const now = Date.now();
      if (latest.settings.soundEnabled && now - (lastSound.current.get(key) ?? 0) > 4000) {
        playMessageSound(latest.volume);
        lastSound.current.set(key, now);
      }
      if (!latest.settings.browserEnabled || isFocused() ||
          typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      try {
        const title = `${incoming.name} · ${incoming.origin}${count > 1 ? ` (${count} mensajes)` : ''}`;
        notifications.current.get(key)?.close();
        const notification = new Notification(title, {
          tag: `anp-${key}`,
          ...(latest.settings.showPreview && incoming.content
            ? { body: incoming.content.slice(0, 160) } : {}),
        });
        notifications.current.set(key, notification);
        notification.onclick = () => {
          window.focus();
          optionsRef.current.navigate(incoming.destination);
          notification.close();
        };
        notification.onclose = () => {
          if (notifications.current.get(key) === notification) notifications.current.delete(key);
        };
      } catch (error) {
        console.warn('El navegador no pudo mostrar la notificación', error);
      }
    }, 650);
    pending.current.set(key, { count, timer });
  });

  return {
    mentionCounts,
    groupUnread,
    clearMentions: (channelId: number) => setMentionCounts(previous => {
      if (!previous.has(channelId)) return previous;
      const next = new Map(previous); next.delete(channelId); return next;
    }),
    clearGroupUnread: (groupId: number) => setGroupUnread(previous => {
      if (!previous.has(groupId)) return previous;
      const next = new Map(previous); next.delete(groupId); return next;
    }),
  };
}