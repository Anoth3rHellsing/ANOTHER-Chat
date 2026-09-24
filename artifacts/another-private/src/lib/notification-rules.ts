import { resolveChannelLevel, type NotificationSettings } from './notification-settings';

export type MessageKind = 'channel' | 'dm' | 'group';

export function isNotificationsMuted(settings: NotificationSettings, now = Date.now()): boolean {
  return settings.muteUntil !== null && settings.muteUntil > now;
}

export function shouldAlertForMessage(input: {
  settings: NotificationSettings;
  kind: MessageKind;
  own: boolean;
  viewingFocused: boolean;
  mentioned?: boolean;
  serverId?: number;
  channelId?: number;
  now?: number;
}): boolean {
  if (input.own || input.viewingFocused || isNotificationsMuted(input.settings, input.now)) return false;
  if (input.kind !== 'channel') return true;
  if (input.serverId === undefined || input.channelId === undefined) return false;
  const level = resolveChannelLevel(input.settings, input.serverId, input.channelId);
  return level === 'all' || (level === 'mentions' && input.mentioned === true);
}