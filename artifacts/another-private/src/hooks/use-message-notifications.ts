import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRealtimeMessages } from '@/providers/realtime-transport';
import { playMessageSound } from '@/lib/voice-sounds';
import { useToast } from '@/hooks/use-toast';
import { isNotificationsMuted, shouldAlertForMessage, type MessageKind } from '@/lib/notification-rules';
import type { NotificationSettings } from '@/lib/notification-settings';
import {
  getListMyUpcomingEventsQueryKey,
  useListMyUpcomingEvents,
} from '@workspace/api-client-react';
import type { ChannelEvent } from '@workspace/api-client-react';

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

const EVENT_TYPES = [
  'message:new', 'mention:new', 'dm_message', 'dm_group:message',
  'event:created', 'event:updated', 'event:rescheduled', 'event:cancelled',
  'event:attendee_cancelled', 'event:rsvp_updated',
] as const;

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
  const { toast } = useToast();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const queryClient = useQueryClient();
  const upcomingQuery = useListMyUpcomingEvents({
    query: {
      queryKey: getListMyUpcomingEventsQueryKey(),
      enabled: options.userId !== undefined,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  });
  const [upcomingUserId, setUpcomingUserId] = useState<number | undefined>();
  const [mentionCounts, setMentionCounts] = useState<Map<number, number>>(new Map());
  const [groupUnread, setGroupUnread] = useState<Map<number, number>>(new Map());
  const mentionedIds = useRef(new Set<string>());
  const alertedIds = useRef(new Set<string>());
  const pending = useRef(new Map<string, { count: number; timer: ReturnType<typeof setTimeout> }>());
  const lastSound = useRef(new Map<string, number>());
  const notifications = useRef(new Map<string, Notification>());
  const reminderTimers = useRef(new Map<number, { startsAt: string; timer: ReturnType<typeof setTimeout> }>());
  const remindedEvents = useRef(new Set<string>());

  useEffect(() => {
    const queryKey = getListMyUpcomingEventsQueryKey();
    setUpcomingUserId(options.userId);
    void queryClient.removeQueries({ queryKey });
    if (options.userId !== undefined) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [options.userId, queryClient]);

  useEffect(() => {
    const pendingMap = pending.current;
    const shown = notifications.current;
    const reminders = reminderTimers.current;
    return () => {
      for (const item of pendingMap.values()) clearTimeout(item.timer);
      pendingMap.clear();
      for (const item of reminders.values()) clearTimeout(item.timer);
      reminders.clear();
      for (const item of shown.values()) item.close();
      shown.clear();
      remindedEvents.current.clear();
      alertedIds.current.clear();
      mentionedIds.current.clear();
      lastSound.current.clear();
      setMentionCounts(new Map());
      setGroupUnread(new Map());
    };
  }, [options.userId]);

  const queueIncoming = (incoming: Incoming) => {
    const current = optionsRef.current;
    const eventNotice = incoming.key.startsWith('event:') || incoming.key.startsWith('event-reminder:');
    const viewingFocused = !eventNotice && isFocused() && sameDestination(current.active, incoming.destination);
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
          (!eventNotice && isFocused() && sameDestination(latest.active, incoming.destination))) return;
      if (eventNotice && document.visibilityState === 'visible') {
        toast({ title: incoming.origin, description: incoming.content });
      }
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
          tag: `anp-${incoming.key}`,
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
  };

  useRealtimeMessages(EVENT_TYPES, payload => {
    const current = optionsRef.current;
    if (!current.userId) return;
    const data = payload.data;
    if (payload.type.startsWith('event:')) {
      void queryClient.invalidateQueries({ queryKey: getListMyUpcomingEventsQueryKey() });
      const eventId = Number(data?.eventId ?? data?.id);
      if (Number.isSafeInteger(eventId)) {
        const timer = reminderTimers.current.get(eventId);
        if (timer) clearTimeout(timer.timer);
        reminderTimers.current.delete(eventId);
      }
      // Only the direct attendee notices carry eventId. The broad event broadcasts
      // are used to refresh authorized reminder data, not to notify every channel member.
      if ((payload.type === 'event:rescheduled' || payload.type === 'event:attendee_cancelled') &&
          data?.eventId !== undefined) {
        const eventId = Number(data.eventId);
        const channelId = Number(data.channelId);
        const serverId = Number(data.serverId);
        const channel = current.channels.get(channelId);
        if (!Number.isSafeInteger(eventId) || !Number.isSafeInteger(channelId) ||
            !Number.isSafeInteger(serverId)) return;
        const own = Number(data.actorId) === current.userId;
        queueIncoming({
          id: eventId,
          key: `event:${payload.type}:${eventId}:${String(data.startsAt ?? '')}`,
          kind: 'channel',
          destination: { kind: 'channel', serverId, channelId },
          name: String(data.title ?? 'Evento'),
          origin: `${payload.type === 'event:attendee_cancelled' ? 'Evento cancelado' : 'Evento reprogramado'} · ${channel?.serverName ?? 'Servidor'} · #${channel?.name ?? `canal ${channelId}`}`,
          content: payload.type === 'event:attendee_cancelled'
            ? `Se canceló el evento “${String(data.title ?? 'Evento')}”.`
            : `Se reprogramó “${String(data.title ?? 'Evento')}” para ${new Date(String(data.startsAt ?? '')).toLocaleString()}.`,
          own,
          mentioned: true,
        });
      }
      return;
    }
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
        content: String(payload.type === 'mention:new' ? data.preview ?? '' : data.content ?? '')
          .replace(/\s*\[event:\d+\]/g, '')
          .trim(),
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

    queueIncoming(incoming);
  });

  useEffect(() => {
    for (const reminder of reminderTimers.current.values()) clearTimeout(reminder.timer);
    reminderTimers.current.clear();
    if (!options.userId || upcomingUserId !== options.userId || !upcomingQuery.data) return;

    const schedule = (event: ChannelEvent) => {
      if (event.myResponse?.status !== 'yes' && event.myResponse?.status !== 'maybe') return;
      const startsAt = event.startsAt;
      const timestamp = new Date(startsAt).getTime();
      if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return;
      const reminderKey = `${event.id}:${startsAt}`;
      if (remindedEvents.current.has(reminderKey)) return;
      const fireAt = Math.max(Date.now(), timestamp - 15 * 60 * 1000);
      const run = () => {
        const remaining = fireAt - Date.now();
        if (remaining > 0) {
          const timer = setTimeout(run, Math.min(remaining, 2_147_000_000));
          reminderTimers.current.set(event.id, { startsAt, timer });
          return;
        }
        reminderTimers.current.delete(event.id);
        if (remindedEvents.current.has(reminderKey)) return;
        const channel = optionsRef.current.channels.get(event.channelId);
        if (!channel) return;
        remindedEvents.current.add(reminderKey);
        queueIncoming({
          id: event.id,
          key: `event-reminder:${reminderKey}`,
          kind: 'channel',
          destination: {
            kind: 'channel',
            serverId: channel.serverId,
            channelId: event.channelId,
          },
          name: event.title,
          origin: `Recordatorio de evento · ${channel.serverName} · #${channel.name}`,
          content: `“${event.title}” comienza pronto.`,
          own: false,
          mentioned: true,
        });
      };
      const timer = setTimeout(run, Math.min(Math.max(0, fireAt - Date.now()), 2_147_000_000));
      reminderTimers.current.set(event.id, { startsAt, timer });
    };
    upcomingQuery.data.forEach(schedule);
  }, [options.userId, upcomingUserId, upcomingQuery.data, [...options.channels.keys()].join(',')]);

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