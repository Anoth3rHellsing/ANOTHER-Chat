import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useLocation } from 'wouter';
import { csrfFetch } from '@workspace/api-client-react';
import { 
  useGetCurrentUser, useListServers, useJoinServer,
  useGetServerMembers, useListChannels,
  useListMessages, useSendMessage, useEditMessage, useDeleteMessage,
  useToggleReaction,
  getGetCurrentUserQueryKey,
  getListChannelsQueryKey, getListServersQueryKey, getGetServerMembersQueryKey,
  useJoinServerByInvite,
  useListDmConversations, useGetDmHistory, useSendDm, useMarkDmRead, useDeleteDm,
  getListDmConversationsQueryKey, getGetDmHistoryQueryKey,
} from '@workspace/api-client-react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useChatWebSocket } from '@/hooks/use-chat-websocket';
import { useDmWebSocket } from '@/hooks/use-dm-websocket';
import { useMessageNotifications } from '@/hooks/use-message-notifications';
import { loadNotificationSettings, saveNotificationSettings, type NotificationSettings } from '@/lib/notification-settings';
import { isNotificationsMuted } from '@/lib/notification-rules';
import { useWebRTC } from '@/hooks/use-webrtc';
import { useSoundboardPlayback } from '@/hooks/use-soundboard-playback';
import { useWatchSession } from '@/hooks/use-watch-session';
import { WatchPlayer } from '@/components/watch-player';
import { WatchPanel } from '@/components/watch-panel';
import { loadSoundboardSettings, saveSoundboardSettings, type SoundboardSettings } from '@/lib/soundboard-settings';
import { SoundboardPanel, type Clip as SoundboardClip } from '@/components/soundboard-panel';
import { RemoteAudioStreams, RemoteVideo } from '@/components/remote-audio';
import { CallStatusBar } from '@/components/call-status-bar';
import { CallExpandedControls } from '@/components/call-expanded-controls';
import { CallSourceControls } from '@/components/call-source-controls';
import { CallScreenGallery } from '@/components/call-screen-gallery';
import {
  sourcePreferencesFor,
  type CallAudioSource,
  type CallVideoSource,
  type PeerSourcePreferences,
  type SourceLevel,
} from '@/lib/call-source-preferences';
import { ProfileModal } from '@/components/profile-modal';
import { SettingsModal } from '@/components/settings-modal';
import { loadSettings, saveSettings, type AudioVideoSettings } from '@/lib/settings-utils';
import { ServerSettingsModal } from '@/components/server-settings-modal';
import { UserProfileCard } from '@/components/user-profile-card';
import { VoiceChannelRow } from '@/components/voice-channel-row';
import { CreateChannelModal } from '@/components/create-channel-modal';
import { CreateServerModal } from '@/components/create-server-modal';
import { StoryBar } from '@/components/story-bar';
import { ClipsView } from '@/components/clips-view';
import { getEffectivePermissions, hasPerm, PERM } from '@/lib/permissions';
import { ChannelEventsEntry, ChannelEventsPanel, EventMessageCard, useEventRealtime } from '@/components/channel-events';
import { ChannelFilesPanel } from '@/components/channel-files-panel';
import { useToast } from '@/hooks/use-toast';
import { 
  Hash, Settings, LogOut, Plus, Shield, ShieldAlert,
  Send, MoreVertical, Edit2, Trash2, Users as UsersIcon, X, SlidersHorizontal,
  Link2, Volume2, Image as ImageIcon, Paperclip, Smile, CornerUpLeft,
  FileText, ExternalLink, Download, MessageSquare, Play, Calendar,
  Cog, Phone, PhoneOff, Mic, MicOff, Music2, Video, VideoOff, Monitor, MonitorOff,
  PhoneIncoming, Minimize2, Clapperboard,
  Search, ChevronLeft, Flag, Bell, ShoppingBag
} from 'lucide-react';
import { SearchModal } from '@/components/search-modal';
import { FriendsPanel } from '@/components/friends-panel';
import { ReportModal } from '@/components/report-modal';
import { MentionList, useMentionAutocomplete } from '@/components/mention-autocomplete';
import { DmGroupModal } from '@/components/dm-group-modal';
import { DmGroupConversation } from '@/components/dm-group-conversation';
import { EmojiPicker, QUICK_EMOJIS, insertEmojiAtCursor } from '@/components/emoji-picker';
import { GifPicker } from '@/components/gif-picker';
import { GifMessage } from '@/components/gif-message';
import { parseGiphyMessage, serializeGiphyMessage } from '@/lib/giphy';
import { sameOriginUploadUrl } from '@/lib/media-url';
import { AvatarImage } from '@/components/avatar-image';
import { ReactionIndicators } from '@/components/reaction-indicators';
import { updateChannelReactions, updateDmReactions, type MessageReaction } from '@/lib/reactions';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

const CHANNEL_TYPE_ICON = {
  text: Hash,
  voice: Volume2,
  media: ImageIcon,
  calendar: Calendar,
} as const;
const CHANNEL_TYPE_LABEL = {
  text: 'Texto',
  voice: 'Voz',
  media: 'Media',
  calendar: 'Calendario',
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isImage(mimeType: string) {
  return mimeType.startsWith('image/');
}

function isVideo(mimeType: string) {
  return mimeType.startsWith('video/');
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function AttachmentRenderer({ attachment }: { attachment: any }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (isImage(attachment.mimeType)) {
    return (
      <>
        <img
          src={sameOriginUploadUrl(attachment.url)}
          alt={attachment.filename}
          className="max-w-xs max-h-64 rounded-lg cursor-pointer hover:opacity-90 transition-opacity object-cover border border-white/10"
          onClick={() => setLightboxOpen(true)}
        />
        {lightboxOpen && (
          <div
            className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
            onClick={() => setLightboxOpen(false)}
          >
            <button className="absolute top-4 right-4 text-white/70 hover:text-white p-2">
              <X className="w-6 h-6" />
            </button>
            <img
              src={sameOriginUploadUrl(attachment.url)}
              alt={attachment.filename}
              className="max-w-full max-h-full object-contain rounded-lg"
              onClick={e => e.stopPropagation()}
            />
          </div>
        )}
      </>
    );
  }

  if (isVideo(attachment.mimeType)) {
    return (
      <video
        src={sameOriginUploadUrl(attachment.url)}
        controls
        className="max-w-xs max-h-64 rounded-lg border border-white/10"
      />
    );
  }

  // Document / generic file
  return (
    <a
      href={sameOriginUploadUrl(attachment.url)}
      download={attachment.filename}
      className="flex items-center gap-3 bg-secondary border border-white/10 rounded-lg px-4 py-3 hover:bg-white/5 transition-colors max-w-xs"
    >
      <FileText className="w-8 h-8 text-primary flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground font-medium truncate">{attachment.filename}</p>
        <p className="text-xs text-muted-foreground">{formatBytes(attachment.size)}</p>
      </div>
      <Download className="w-4 h-4 text-muted-foreground flex-shrink-0" />
    </a>
  );
}

function LinkPreviewCard({ preview, onDismiss }: { preview: any; onDismiss: () => void }) {
  return (
    <div className="mt-2 border border-white/10 rounded-lg overflow-hidden bg-secondary max-w-md relative">
      <button
        onClick={onDismiss}
        className="absolute top-2 right-2 text-muted-foreground hover:text-white z-10"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <a href={preview.url} target="_blank" rel="noopener noreferrer" className="block hover:bg-white/5 transition-colors">
        {preview.imageUrl && (
          <img src={preview.imageUrl} alt="" className="w-full h-32 object-cover" />
        )}
        <div className="p-3">
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mb-1 flex items-center gap-1">
            <ExternalLink className="w-3 h-3" />
            {preview.domain}
          </p>
          {preview.title && (
            <p className="text-sm font-medium text-foreground line-clamp-2">{preview.title}</p>
          )}
          {preview.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{preview.description}</p>
          )}
        </div>
      </a>
    </div>
  );
}

function ReplyQuote({ replyTo, onClick }: { replyTo: any; onClick?: () => void }) {
  return (
    <div
      className="flex items-start gap-2 mb-1 pl-3 border-l-2 border-primary/50 cursor-pointer group/reply"
      onClick={onClick}
    >
      <CornerUpLeft className="w-3 h-3 text-primary/60 flex-shrink-0 mt-0.5" />
      <div className="min-w-0">
        <span className="text-xs text-primary/70 font-medium">{replyTo.authorDisplayName}</span>
        <p className="text-xs text-muted-foreground truncate group-hover/reply:text-foreground transition-colors">
          {replyTo.contentPreview}
        </p>
      </div>
    </div>
  );
}

function QuickReactionButtons({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <div className="flex items-center border-r border-border pr-1" aria-label="Reacciones rápidas">
      {QUICK_EMOJIS.slice(0, 4).map(emoji => (
        <button
          key={emoji}
          type="button"
          onClick={() => onSelect(emoji)}
          title={`Reaccionar con ${emoji}`}
          aria-label={`Reaccionar con ${emoji}`}
          className="p-1 text-sm rounded hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AppLayout() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: user, isLoading: userLoading } = useGetCurrentUser();
  const { data: servers, isLoading: serversLoading } = useListServers();

  const [activeServerId, setActiveServerId] = useState<number | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<number | null>(null);

  // DM state
  const [activeView, setActiveView] = useState<'servers' | 'dms'>('servers');
  const [activeDmUserId, setActiveDmUserId] = useState<number | null>(null);
  const [activeDmGroupId, setActiveDmGroupId] = useState<number | null>(null);
  const [dmInput, setDmInput] = useState('');
  const dmInputRef = useRef<HTMLInputElement>(null);
  const [dmReplyingTo, setDmReplyingTo] = useState<any | null>(null);
  const dmMessagesEndRef = useRef<HTMLDivElement>(null);
  const dmTypingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [audioVideoProfile, setAudioVideoProfile] = useState<{ userId: number; settings: AudioVideoSettings } | null>(null);
  const audioVideoSettings = audioVideoProfile && audioVideoProfile.userId === user?.id
    ? audioVideoProfile.settings : loadSettings(user?.id ?? 0);
  useEffect(() => {
    if (user?.id) setAudioVideoProfile({ userId: user.id, settings: loadSettings(user.id) });
  }, [user?.id]);
  const [soundboardProfile, setSoundboardProfile] = useState<{ userId: number; settings: SoundboardSettings } | null>(null);
  const soundboardSettings = soundboardProfile && soundboardProfile.userId === user?.id
    ? soundboardProfile.settings : loadSoundboardSettings(user?.id ?? 0);
  const [isSoundboardOpen, setIsSoundboardOpen] = useState(false);
  const [isWatchOpen, setIsWatchOpen] = useState(false);
  const [localWatchVolume, setLocalWatchVolume] = useState(0.6);
  useEffect(() => {
    if (user?.id) setSoundboardProfile({ userId: user.id, settings: loadSoundboardSettings(user.id) });
  }, [user?.id]);
  const updateSoundboardSettings = (next: SoundboardSettings) => {
    if (!user?.id) return;
    if (!saveSoundboardSettings(user.id, next)) {
      toast({ title: 'No se pudieron guardar los ajustes del soundboard en este navegador', variant: 'destructive' });
    }
    setSoundboardProfile({ userId: user.id, settings: next });
  };
  const [notificationProfile, setNotificationProfile] = useState<{ userId: number; settings: NotificationSettings } | null>(null);
  const notificationSettings = notificationProfile && notificationProfile.userId === user?.id
    ? notificationProfile.settings : loadNotificationSettings(user?.id ?? 0);
  const [windowFocused, setWindowFocused] = useState(() => document.visibilityState === 'visible' && document.hasFocus());
  useEffect(() => {
    const refresh = () => setWindowFocused(document.visibilityState === 'visible' && document.hasFocus());
    window.addEventListener('focus', refresh);
    window.addEventListener('blur', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('blur', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  useEffect(() => {
    if (user?.id) setNotificationProfile({ userId: user.id, settings: loadNotificationSettings(user.id) });
  }, [user?.id]);
  const updateNotificationSettings = (next: NotificationSettings) => {
    if (!user?.id) return;
    if (!saveNotificationSettings(user.id, next)) {
      toast({ title: 'No se pudieron guardar las preferencias de notificación en este navegador', variant: 'destructive' });
    }
    setNotificationProfile({ userId: user.id, settings: next });
  };
  const [isCallMinimized, setIsCallMinimized] = useState(false);
  const [callSourcePreferences, setCallSourcePreferences] = useState<Map<number, PeerSourcePreferences>>(new Map());
  const [showCallSources, setShowCallSources] = useState(false);
  const [featuredScreenKey, setFeaturedScreenKey] = useState<string | null>(null);
  const [joinedVoiceChannelName, setJoinedVoiceChannelName] = useState<string | null>(null);
  const [isServerSettingsOpen, setIsServerSettingsOpen] = useState(false);
  const [showClips, setShowClips] = useState(false);
  const [isCreateServerOpen, setIsCreateServerOpen] = useState(false);
  const [isCreateChannelOpen, setIsCreateChannelOpen] = useState(false);
  const [isJoinByCodeOpen, setIsJoinByCodeOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [showMembers, setShowMembers] = useState(true);
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  const [mobileMessageActions, setMobileMessageActions] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  useEffect(() => {
    setShowEvents(false);
  }, [activeChannelId]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedAnchorRect, setSelectedAnchorRect] = useState<DOMRect | null>(null);

  // Messaging state
  const [messageInput, setMessageInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editInput, setEditInput] = useState('');

  // Reply state
  const [replyingTo, setReplyingTo] = useState<any | null>(null);

  // Attachment state
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingAttachmentIds, setPendingAttachmentIds] = useState<number[]>([]);
  const [uploadingFile, setUploadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Emoji picker state
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<number | null>(null);
  const [dmEmojiPickerMsgId, setDmEmojiPickerMsgId] = useState<number | null>(null);
  const [composerEmojiPicker, setComposerEmojiPicker] = useState<'channel' | 'dm' | null>(null);
  const [composerGifPicker, setComposerGifPicker] = useState<'channel' | 'dm' | null>(null);
  const [pendingReactions, setPendingReactions] = useState<Set<string>>(new Set());

  // Dismissed link previews (by message id)
  const [dismissedPreviews, setDismissedPreviews] = useState<Set<number>>(new Set());

  // Mobile layout depth: 0=server list, 1=channel/DM list, 2=chat
  const [mobilePanelDepth, setMobilePanelDepth] = useState(0);
  const [desktopLayout, setDesktopLayout] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const update = () => setDesktopLayout(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const chatPaneVisible = desktopLayout || mobilePanelDepth >= 2;
  useEffect(() => {
    if (!mobileMembersOpen || desktopLayout) return;
    window.history.pushState({ ...window.history.state, mobileMembers: true }, '');
    const onBack = () => setMobileMembersOpen(false);
    window.addEventListener('popstate', onBack);
    return () => window.removeEventListener('popstate', onBack);
  }, [mobileMembersOpen, desktopLayout]);
  const closeMobileMembers = () => {
    if (window.history.state?.mobileMembers) window.history.back();
    else setMobileMembersOpen(false);
  };
  // Search modal
  const [showSearch, setShowSearch] = useState(false);
  // Report modal
  const [reportTarget, setReportTarget] = useState<{ messageId: number; authorName: string } | null>(null);
  // Mention autocomplete
  const [mentionCursorPos, setMentionCursorPos] = useState(0);
  const [selectedMentionIdx, setSelectedMentionIdx] = useState(0);
  const msgInputRef = useRef<HTMLInputElement>(null);
  // Friends / DM group view toggle in DM panel
  const [dmSubView, setDmSubView] = useState<'messages' | 'friends'>('messages');
  // DM group modal
  const [showDmGroupModal, setShowDmGroupModal] = useState(false);
  const [dmFriends, setDmFriends] = useState<any[]>([]);
  // Mute status (shows banner when muted in active server)
  const [muteStatus, setMuteStatus] = useState<{ expiresAt: string; reason?: string } | null>(null);

  const openProfileCard = (userId: number, e: React.MouseEvent) => {
    if (userId === user?.id) {
      setIsProfileOpen(true);
      return;
    }
    setSelectedUserId(userId);
    setSelectedAnchorRect((e.currentTarget as HTMLElement).getBoundingClientRect());
  };

  // Derive active items
  useEffect(() => {
    if (servers && servers.length > 0 && !activeServerId) {
      setActiveServerId(servers[0].id);
    }
  }, [servers, activeServerId]);

  const { data: channels } = useListChannels(activeServerId as number, { query: { enabled: !!activeServerId } as any });
  
  useEffect(() => {
    if (channels && channels.length > 0 && activeServerId) {
      const validChannel = channels.find(c => c.id === activeChannelId);
      if (!validChannel) setActiveChannelId(channels[0].id);
    } else if (channels && channels.length === 0) {
      setActiveChannelId(null);
    }
  }, [channels, activeServerId, activeChannelId]);

  const { data: members } = useGetServerMembers(activeServerId as number, { query: { enabled: !!activeServerId } as any });
  const selectedChannelType = channels?.find(channel => channel.id === activeChannelId)?.channelType ?? 'text';
  const { data: messages } = useListMessages(activeChannelId as number, {}, {
    query: { enabled: !!activeChannelId && selectedChannelType !== 'calendar' } as any,
  });
  
  useEventRealtime();

  // Reuse the generated channels cache; one initial fetch per server, never polling.
  const channelQueries = useQueries({
    queries: (servers ?? []).map(server => ({
      queryKey: getListChannelsQueryKey(server.id),
      queryFn: async (): Promise<Array<{ id: number; serverId: number; name: string }>> => {
        const base = import.meta.env.BASE_URL.replace(/\/$/, '');
        const response = await csrfFetch(`${base}/api/servers/${server.id}/channels`, { credentials: 'include' });
        if (!response.ok) throw new Error('No se pudieron cargar los canales');
        return response.json();
      },
      enabled: !!user,
    })),
  });
  const channelMetadata = new Map<number, { serverId: number; name: string; serverName: string }>();
  channelQueries.forEach((query, index) => {
    const server = servers?.[index];
    if (!server || !Array.isArray(query.data)) return;
    query.data.forEach(channel => channelMetadata.set(channel.id, {
      serverId: server.id, name: channel.name, serverName: server.name,
    }));
  });
  const allChannelIds = [...channelMetadata.keys()];
  const mentionMembers = useMemo(() => (members ?? []).map((m: any) => m.user).filter(Boolean), [members]);
  const { suggestions: mentionSuggestions, insertMention } = useMentionAutocomplete(messageInput, mentionCursorPos, mentionMembers);
  const { typingUsers, sendTypingStart, sendTypingStop, unreadCounts, clearUnread } = useChatWebSocket(
    activeView === 'servers' && !showClips ? activeChannelId : null,
    allChannelIds, undefined, user?.id, windowFocused && chatPaneVisible,
  );
  const { dmTypingUsers, sendDmTypingStart, sendDmTypingStop } = useDmWebSocket(activeDmUserId);

  // WebRTC — voice channels + DM calls
  const webrtc = useWebRTC({
    currentUserId: user?.id ?? 0,
    settings: audioVideoSettings,
  });
  const isCallActive = webrtc.isInVoiceChannel || webrtc.callState === 'connected';
  const soundboardPlayback = useSoundboardPlayback({
    userId: user?.id,
    settings: soundboardSettings,
    activeVoiceChannelId: webrtc.isInVoiceChannel ? webrtc.activeVoiceChannelId : null,
    activeDmPeerId: !webrtc.isInVoiceChannel && webrtc.callState === 'connected' ? webrtc.dmCallUserId : null,
  });
  useEffect(() => {
    if (!isCallActive) {
      setIsCallMinimized(false);
      setIsSoundboardOpen(false);
    }
  }, [isCallActive]);
  const currentCallKey = webrtc.isInVoiceChannel && webrtc.activeVoiceChannelId
    ? `voice:${webrtc.activeVoiceChannelId}`
    : webrtc.callState === 'connected' && webrtc.dmCallUserId
      ? `dm:${webrtc.dmCallUserId}` : null;
  useEffect(() => {
    setCallSourcePreferences(new Map());
    setFeaturedScreenKey(null);
    setShowCallSources(false);
  }, [currentCallKey]);
  const changeSourceLevel = (peerId: number, source: CallAudioSource, patch: Partial<SourceLevel>) => {
    setCallSourcePreferences(previous => {
      const next = new Map(previous);
      const current = sourcePreferencesFor(previous, peerId);
      next.set(peerId, {
        ...current,
        [source]: {
          ...current[source],
          ...patch,
          volume: patch.volume === undefined ? current[source].volume : Math.max(0, Math.min(1, patch.volume)),
        },
      });
      return next;
    });
  };
  const toggleSourceVideo = (peerId: number, source: CallVideoSource) => {
    setCallSourcePreferences(previous => {
      const next = new Map(previous);
      const current = sourcePreferencesFor(previous, peerId);
      next.set(peerId, {
        ...current,
        [source === 'camera' ? 'cameraVisible' : 'screenVisible']:
          !(source === 'camera' ? current.cameraVisible : current.screenVisible),
      });
      return next;
    });
    if (source === 'screen' && featuredScreenKey === `peer-${peerId}`) setFeaturedScreenKey(null);
  };
  const watch = useWatchSession({
    userId: user?.id,
    scope: webrtc.isInVoiceChannel ? 'voice' : webrtc.callState === 'connected' ? 'dm' : null,
    targetId: webrtc.isInVoiceChannel ? webrtc.activeVoiceChannelId : webrtc.dmCallUserId,
    enabled: isCallActive,
  });
  const isWatchVisible = isCallActive && isWatchOpen;
  useEffect(() => {
    if (!isCallActive) setIsWatchOpen(false);
  }, [isCallActive]);
  const currentCallKeyRef = useRef(currentCallKey);
  currentCallKeyRef.current = currentCallKey;
  const triggerSoundboardClip = async (clip: SoundboardClip) => {
    if (!isCallActive) throw new Error('La llamada ya no está activa');
    const callAtTrigger = currentCallKeyRef.current;
    const call = webrtc.isInVoiceChannel
      ? { callType: 'voice' as const, channelId: webrtc.activeVoiceChannelId }
      : { callType: 'dm' as const, peerId: webrtc.dmCallUserId };
    if (call.callType === 'voice' && !call.channelId ||
        call.callType === 'dm' && !call.peerId) throw new Error('La llamada aún no está lista');
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    const response = await csrfFetch(`${base}/api/soundboard/trigger`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipId: clip.id, ...call }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error ?? 'No se pudo disparar el sonido');
    }
    if (currentCallKeyRef.current === callAtTrigger) await soundboardPlayback.playLocalClip(clip);
  };

  // DM data
  const { data: dmConversations, refetch: refetchDmConversations } = useListDmConversations({ query: { enabled: !!user } as any });
  const { data: dmMessages } = useGetDmHistory(activeDmUserId as number, { query: { enabled: !!activeDmUserId } as any });
  const { data: dmGroups = [] } = useQuery<Array<{ id: number; name: string; memberCount: number }>>({
    queryKey: ['/api/dm-groups'],
    queryFn: async () => {
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const response = await csrfFetch(`${base}/api/dm-groups`, { credentials: 'include' });
      if (!response.ok) throw new Error('No se pudieron cargar los grupos');
      return response.json();
    },
    enabled: !!user,
  });
  const totalDmUnread = useMemo(() => (dmConversations ?? []).reduce((sum: number, c: any) => sum + (c.unreadCount ?? 0), 0), [dmConversations]);
  const dmNames = new Map<number, string>((dmConversations ?? [])
    .filter((conversation: any) => conversation.otherUser?.id)
    .map((conversation: any) => [conversation.otherUser.id, conversation.otherUser.displayName]));
  const groupNames = new Map(dmGroups.map(group => [group.id, group.name]));
  const notifications = useMessageNotifications({
    userId: user?.id, settings: notificationSettings, volume: audioVideoSettings.volume,
    channels: channelMetadata, dmNames, groupNames,
    active: chatPaneVisible && activeView === 'servers' && !showClips && activeChannelId && activeServerId
      ? { kind: 'channel', channelId: activeChannelId, serverId: activeServerId }
      : chatPaneVisible && activeView === 'dms' && dmSubView === 'messages' && activeDmGroupId
      ? { kind: 'group', groupId: activeDmGroupId }
      : chatPaneVisible && activeView === 'dms' && dmSubView === 'messages' && activeDmUserId
      ? { kind: 'dm', userId: activeDmUserId } : null,
    navigate: destination => {
      setLocation('/app');
      setMobilePanelDepth(2);
      setShowClips(false);
      setDmSubView('messages');
      if (destination.kind === 'channel') {
        setActiveView('servers');
        setActiveServerId(destination.serverId);
        setActiveChannelId(destination.channelId);
      } else {
        setActiveView('dms');
        setActiveDmGroupId(destination.kind === 'group' ? destination.groupId : null);
        setActiveDmUserId(destination.kind === 'dm' ? destination.userId : null);
      }
    },
  });
  const groupUnreadTotal = [...notifications.groupUnread.values()].reduce((sum, count) => sum + count, 0);
  const [notificationClock, setNotificationClock] = useState(Date.now);
  useEffect(() => {
    if (!notificationSettings.muteUntil) return;
    const remaining = notificationSettings.muteUntil - Date.now();
    if (remaining <= 0) { setNotificationClock(Date.now()); return; }
    const timeout = window.setTimeout(() => setNotificationClock(Date.now()), remaining);
    return () => window.clearTimeout(timeout);
  }, [notificationSettings.muteUntil]);
  const muteActive = isNotificationsMuted(notificationSettings, notificationClock);
  const sendDm = useSendDm();
  const markDmRead = useMarkDmRead();
  const deleteDm = useDeleteDm();
  const activeDmConvo = useMemo(() => (dmConversations ?? []).find((c: any) => c.otherUser?.id === activeDmUserId), [dmConversations, activeDmUserId]);

  const sendMessage = useSendMessage();
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage();
  const toggleReaction = useToggleReaction();
  const joinByInvite = useJoinServerByInvite();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  useEffect(() => {
    dmMessagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [dmMessages]);

  // A selected but hidden conversation is not read. Reconcile each new arrival
  // while it really is visible and focused, using the existing read cursor.
  const lastMarkedDmRef = useRef<string | null>(null);
  useEffect(() => {
    if (!windowFocused || !chatPaneVisible || activeView !== 'dms' ||
        dmSubView !== 'messages' || !activeDmUserId || !user) return;
    const latest = dmMessages?.at(-1);
    const key = `${user.id}:${activeDmUserId}:${latest?.id ?? 'open'}`;
    if (lastMarkedDmRef.current === key) return;
    lastMarkedDmRef.current = key;
    markDmRead.mutate({ userId: activeDmUserId }, {
      onSuccess: () => refetchDmConversations(),
      onError: () => { if (lastMarkedDmRef.current === key) lastMarkedDmRef.current = null; },
    });
  }, [activeDmUserId, activeView, dmSubView, windowFocused, chatPaneVisible, dmMessages, user?.id]);

  // Mute status — poll when server changes
  useEffect(() => {
    if (!activeServerId) { setMuteStatus(null); return; }
    const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
    csrfFetch(`${BASE}/api/servers/${activeServerId}/mute-status`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setMuteStatus(d?.muted ? { expiresAt: d.expiresAt, reason: d.reason } : null))
      .catch(() => setMuteStatus(null));
  }, [activeServerId]);

  // Fetch friends list when DM group modal opens
  useEffect(() => {
    if (!showDmGroupModal) return;
    const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
    csrfFetch(`${BASE}/api/friends`, { credentials: 'include' })
      .then(r => r.json()).then(d => setDmFriends(Array.isArray(d) ? d : [])).catch(() => {});
  }, [showDmGroupModal]);

  // Mobile panel auto-advance
  useEffect(() => {
    if (activeServerId !== null) setMobilePanelDepth(d => Math.max(d, 1));
  }, [activeServerId]);
  useEffect(() => {
    if (activeChannelId !== null) setMobilePanelDepth(2);
  }, [activeChannelId]);
  useEffect(() => {
    if (activeDmUserId !== null) setMobilePanelDepth(2);
  }, [activeDmUserId]);
  useEffect(() => {
    if (activeDmGroupId !== null) setMobilePanelDepth(2);
  }, [activeDmGroupId]);

  const openDm = useCallback((targetUserId: number) => {
    setActiveView('dms');
    setActiveDmGroupId(null);
    setActiveDmUserId(targetUserId);
  }, []);

  useEffect(() => {
    setEmojiPickerMsgId(null);
    setDmEmojiPickerMsgId(null);
    setComposerEmojiPicker(null);
  }, [activeView, activeChannelId, activeDmUserId, activeDmGroupId]);

  // ─── File upload helpers ──────────────────────────────────────────────────

  const uploadFile = useCallback(async (file: File) => {
    if (!activeChannelId) return;
    setUploadingFile(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await csrfFetch(`/api/channels/${activeChannelId}/attachments`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setPendingAttachmentIds(prev => [...prev, data.id]);
    } catch {
      toast({ title: 'Error al subir el archivo', variant: 'destructive' });
    } finally {
      setUploadingFile(false);
    }
  }, [activeChannelId, toast]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    // Reset input so the same file can be selected again
    e.target.value = '';
    const newFiles = files.slice(0, 5); // max 5 files at once
    setPendingFiles(prev => [...prev, ...newFiles]);
    for (const file of newFiles) {
      await uploadFile(file);
    }
  };

  const removePendingFile = (idx: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx));
    setPendingAttachmentIds(prev => prev.filter((_, i) => i !== idx));
  };

  // ─── Message handlers ─────────────────────────────────────────────────────

  const handleMessageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageInput(e.target.value);
    sendTypingStart();
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => sendTypingStop(), 2000);
  };

  const sendChannelContent = (content: string, isGif = false) => {
    const hasContent = content.trim().length > 0;
    const hasAttachments = !isGif && pendingAttachmentIds.length > 0;
    if ((!hasContent && !hasAttachments) || !activeChannelId || uploadingFile) return;
    const channelId = activeChannelId;

    sendMessage.mutate(
      {
        channelId,
        data: {
          content: content.trim() || ' ',
          ...(replyingTo ? { replyToId: replyingTo.id } : {}),
          ...(hasAttachments ? { attachmentIds: pendingAttachmentIds } : {}),
        },
      },
      {
        onSuccess: (newMessage) => {
          queryClient.setQueriesData(
            { predicate: (q) => q.queryKey[0] === `/api/channels/${channelId}/messages` },
            (old: any) => {
              if (!old) return [newMessage];
              if (old.some((m: any) => m.id === (newMessage as any).id)) return old;
              return [...old, newMessage];
            }
          );
          if (!isGif) setMessageInput('');
          setReplyingTo(null);
          if (!isGif) {
            setPendingFiles([]);
            setPendingAttachmentIds([]);
          }
          sendTypingStop();
        }
      }
    );
  };
  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    sendChannelContent(messageInput);
  };

  const handleEditMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editInput.trim() || !editingMessageId || !activeChannelId) return;
    editMessage.mutate(
      { channelId: activeChannelId, messageId: editingMessageId, data: { content: editInput.trim() } },
      { onSuccess: () => { setEditingMessageId(null); setEditInput(''); } }
    );
  };

  // ─── DM message handlers ──────────────────────────────────────────────────

  const handleDmInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDmInput(e.target.value);
    if (!activeDmUserId) return;
    sendDmTypingStart(activeDmUserId);
    if (dmTypingTimeoutRef.current) clearTimeout(dmTypingTimeoutRef.current);
    dmTypingTimeoutRef.current = setTimeout(() => activeDmUserId && sendDmTypingStop(activeDmUserId), 2000);
  };

  const sendDmContent = (content: string, isGif = false) => {
    if (!content.trim() || !activeDmUserId) return;
    const recipientId = activeDmUserId;
    sendDm.mutate(
      { userId: recipientId, data: { content: content.trim(), ...(dmReplyingTo ? { replyToId: dmReplyingTo.id } : {}) } },
      {
        onSuccess: (msg: any) => {
          queryClient.setQueriesData(
            { predicate: q => q.queryKey[0] === `/api/dms/${recipientId}` },
            (old: any) => {
              if (!Array.isArray(old)) return [msg];
              if (old.some((m: any) => m.id === msg.id)) return old;
              return [...old, msg];
            }
          );
          queryClient.invalidateQueries({ predicate: q => q.queryKey[0] === '/api/dms' });
          if (!isGif) setDmInput('');
          setDmReplyingTo(null);
          if (activeDmUserId) sendDmTypingStop(activeDmUserId);
        }
      }
    );
  };
  const handleSendDm = (e: React.FormEvent) => {
    e.preventDefault();
    sendDmContent(dmInput);
  };

  const handleJoinByCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinCode.trim()) return;
    joinByInvite.mutate(
      { data: { code: joinCode.trim() } },
      {
        onSuccess: (server: any) => {
          queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
          setActiveServerId(server.id);
          setJoinCode('');
          setIsJoinByCodeOpen(false);
          toast({ title: `Te uniste a ${server.name}` });
        },
        onError: () => {
          toast({ title: 'Código inválido o expirado', variant: 'destructive' });
        },
      }
    );
  };

  const handleReact = (messageId: number, emoji: string) => {
    if (!activeChannelId) return;
    const channelId = activeChannelId;
    const key = `channel:${messageId}:${emoji}`;
    if (pendingReactions.has(key)) return;
    setPendingReactions(prev => new Set(prev).add(key));
    toggleReaction.mutate({ messageId, data: { emoji } }, {
      onSuccess: reactions => updateChannelReactions(queryClient, channelId, messageId, reactions as MessageReaction[]),
      onError: () => toast({ title: 'No se pudo actualizar la reacción', variant: 'destructive' }),
      onSettled: () => setPendingReactions(prev => { const next = new Set(prev); next.delete(key); return next; }),
    });
  };

  const handleDmReact = async (messageId: number, emoji: string) => {
    if (!activeDmUserId) return;
    const key = `dm:${messageId}:${emoji}`;
    if (pendingReactions.has(key)) return;
    setPendingReactions(prev => new Set(prev).add(key));
    try {
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const response = await csrfFetch(`${base}/api/dms/messages/${messageId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ emoji }),
      });
      if (!response.ok) throw new Error('No se pudo actualizar la reacción');
      updateDmReactions(queryClient, messageId, await response.json() as MessageReaction[]);
    } catch {
      toast({ title: 'No se pudo actualizar la reacción', variant: 'destructive' });
    } finally {
      setPendingReactions(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  const scrollToMessage = (msgId: number) => {
    const el = messageRefs.current.get(msgId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Reading requires the actual conversation to be visible and the window focused.
  useEffect(() => {
    if (!windowFocused || !chatPaneVisible) return;
    if (activeView === 'servers' && !showClips && activeChannelId) {
      clearUnread(activeChannelId);
      notifications.clearMentions(activeChannelId);
    }
    if (activeView === 'dms' && dmSubView === 'messages' && activeDmGroupId) {
      notifications.clearGroupUnread(activeDmGroupId);
    }
  }, [activeChannelId, activeDmGroupId, activeView, dmSubView, showClips, windowFocused, chatPaneVisible]);

  // Redirect to login when auth check completes and there's no user.
  useEffect(() => {
    if (!userLoading && !user) setLocation('/');
  }, [userLoading, user, setLocation]);

  const activeServer = servers?.find(s => s.id === activeServerId);
  const activeChannel = channels?.find(c => c.id === activeChannelId);
  useEffect(() => {
    if (webrtc.voiceEventNotice) toast({ title: webrtc.voiceEventNotice.text });
  }, [webrtc.voiceEventNotice, toast]);
  const activeChannelType = (activeChannel as any)?.channelType ?? 'text';
  const ActiveChannelIcon = CHANNEL_TYPE_ICON[activeChannelType as keyof typeof CHANNEL_TYPE_ICON] ?? Hash;
  const callPeer = (dmConversations ?? []).find((convo: any) => convo.otherUser?.id === webrtc.dmCallUserId)?.otherUser;
  const watchParticipantCandidates = webrtc.isInVoiceChannel
    ? [
        ...(user ? [{ userId: user.id, displayName: user.displayName }] : []),
        ...webrtc.voiceMembers.map(member => ({ userId: member.userId, displayName: member.displayName })),
      ]
    : webrtc.dmCallUserId ? [
        ...(user ? [{ userId: user.id, displayName: user.displayName }] : []),
        {
          userId: webrtc.dmCallUserId,
          displayName: callPeer?.displayName ?? `Usuario ${webrtc.dmCallUserId}`,
        },
      ] : [];
  const watchParticipants = [...new Map(
    watchParticipantCandidates.map(participant => [participant.userId, participant]),
  ).values()];
  const remotePeerIds = new Set([
    ...webrtc.voiceMembers.map(member => member.userId),
    ...webrtc.remoteStreams.keys(),
    ...webrtc.remoteScreenStreams.keys(),
    ...webrtc.remoteAudioTracks.keys(),
    ...(!webrtc.isInVoiceChannel && webrtc.dmCallUserId ? [webrtc.dmCallUserId] : []),
  ]);
  const sourceParticipants = [...remotePeerIds]
    .filter(peerId => peerId !== user?.id)
    .map(peerId => ({
      userId: peerId,
      displayName: webrtc.voiceMembers.find(member => member.userId === peerId)?.displayName
        ?? (webrtc.dmCallUserId === peerId ? callPeer?.displayName : null)
        ?? `Usuario ${peerId}`,
      hasMicrophone: !!webrtc.remoteAudioTracks.get(peerId)?.microphone,
      hasCamera: !!webrtc.remoteStreams.get(peerId)?.getVideoTracks().some(track => track.readyState === 'live'),
      hasScreen: webrtc.remoteScreenStreams.has(peerId),
      hasScreenAudio: webrtc.remoteScreenStreams.has(peerId) &&
        webrtc.remoteAudioTracks.get(peerId)?.screen?.readyState === 'live' &&
        !webrtc.remoteAudioTracks.get(peerId)?.screen?.muted,
      preferences: sourcePreferencesFor(callSourcePreferences, peerId),
    }));
  const callStatusBar = isCallActive ? (
    <CallStatusBar
      name={webrtc.isInVoiceChannel
        ? channels?.find(c => c.id === webrtc.activeVoiceChannelId)?.name ?? joinedVoiceChannelName ?? 'Voz'
        : `Llamada con ${callPeer?.displayName ?? `Usuario ${webrtc.dmCallUserId}`}`}
      status={webrtc.isInVoiceChannel && webrtc.voiceConnectionStatus !== 'connected'
        ? webrtc.voiceConnectionStatus === 'reconnecting' ? 'Reconectando voz…' : 'Recuperando voz…'
        : 'Conectado'}
      participants={webrtc.isInVoiceChannel
        ? `${webrtc.voiceMembers.length + 1} ${webrtc.voiceMembers.length ? 'participantes' : 'participante'}`
        : '2 participantes'}
      isMuted={webrtc.isMuted}
      isMinimized={isCallMinimized}
      onToggleMute={webrtc.toggleMute}
      onHangUp={() => webrtc.isInVoiceChannel ? webrtc.leaveVoiceChannel() : webrtc.endCall()}
      onExpand={() => setIsCallMinimized(false)}
      onOpenSoundboard={() => setIsSoundboardOpen(open => !open)}
      onOpenWatch={() => { setIsSoundboardOpen(false); setIsWatchOpen(open => !open); }}
      isWatching={isWatchVisible}
      hasWatchInvitation={!!watch.session && !watch.isWatching}
      onOpenSources={() => setShowCallSources(open => !open)}
      isSourcesOpen={showCallSources}
    />
  ) : null;

  // Compute per-server unread count for server icon badges
  const serverUnread = useMemo(() => {
    if (!channels) return 0;
    return channels.reduce((sum, c) => sum + (unreadCounts.get(c.id) ?? 0), 0);
  }, [channels, unreadCounts]);

  const currentMembership = useMemo(() => {
    if (!members || !user) return null;
    return members.find(m => m.userId === user.id) ?? null;
  }, [members, user]);

  const myPermissions = useMemo(() => {
    if (!currentMembership) return 0;
    return getEffectivePermissions(currentMembership.role, currentMembership.roles ?? []);
  }, [currentMembership]);

  const canManageServer = user?.role === 'admin' ||
    currentMembership?.role === 'owner' ||
    currentMembership?.role === 'admin';

  const canCreateChannel = canManageServer || hasPerm(myPermissions, PERM.MANAGE_CHANNELS);

  const groupedMembers = useMemo(() => {
    if (!members) return { online: [], offline: [] };
    return members.reduce((acc, m) => {
      if (m.user.status === 'offline') acc.offline.push(m);
      else acc.online.push(m);
      return acc;
    }, { online: [] as any[], offline: [] as any[] });
  }, [members]);

  const getStatusColor = (status: string) => {
    switch(status) {
      case 'online': return 'bg-green-500';
      case 'away': return 'bg-yellow-500';
      case 'dnd': return 'bg-red-500';
      default: return 'bg-gray-500';
    }
  };

  if (userLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center text-primary">
        <Shield className="w-8 h-8 animate-pulse" />
      </div>
    );
  }
  if (!user) return null;

  const sharedScreens = [
    ...Array.from(webrtc.remoteScreenStreams.entries(), ([peerId, stream]) => ({
      key: `peer-${peerId}`,
      peerId,
      stream,
      label: webrtc.voiceMembers.find(member => member.userId === peerId)?.displayName
        ?? (dmConversations ?? []).find(conversation => conversation.otherUser?.id === peerId)?.otherUser?.displayName
        ?? `Usuario ${peerId}`,
      local: false,
      visible: sourcePreferencesFor(callSourcePreferences, peerId).screenVisible,
    })),
    ...(webrtc.screenStream ? [{
      key: 'local',
      peerId: null,
      stream: webrtc.screenStream,
      label: `${user.displayName} (vos)`,
      local: true,
      visible: true,
      audioAvailable: webrtc.screenAudioAvailable,
    }] : []),
  ];

  return (
    <div className={`h-screen w-full bg-background flex overflow-hidden font-sans ${isWatchVisible && isCallMinimized ? 'pt-[55dvh] md:pt-0 md:pr-[min(520px,40vw)]' : ''}`}>
      {muteActive && (
        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          className="fixed top-3 left-1/2 -translate-x-1/2 z-[45] max-w-[calc(100vw-1rem)] truncate rounded-full border border-primary/50 bg-card px-4 py-1.5 text-xs font-medium text-primary shadow-lg glow-effect"
          title="Abrir ajustes de notificaciones"
        >
          <Bell className="inline h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          Notificaciones silenciadas hasta {new Date(notificationSettings.muteUntil!).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
        </button>
      )}
      
      {/* 1. SERVER LIST COLUMN */}
      <div className={`${mobilePanelDepth === 0 ? 'flex w-full h-full' : 'hidden'} md:flex md:w-[72px] bg-card border-r border-white/5 flex-col items-center py-4 gap-3 md:flex-shrink-0 z-20`}>
        <div
          className={`w-12 h-12 rounded-2xl flex items-center justify-center cursor-pointer hover:rounded-xl transition-all ${activeView === 'servers' ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground hover:bg-primary/15 hover:text-primary'}`}
          onClick={() => { setActiveView('servers'); setLocation('/app'); }}
        >
          <Shield className="w-7 h-7" />
        </div>

        {/* DM button with unread badge */}
        <div className="relative group">
          <button
            onClick={() => { setActiveView('dms'); setMobilePanelDepth(1); }}
            className={`w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all flex items-center justify-center border ${activeView === 'dms' ? 'rounded-[16px] bg-primary/20 text-primary border-primary/40 glow-effect' : 'bg-secondary text-muted-foreground hover:bg-primary/15 hover:text-primary border-white/5'}`}
            title="Mensajes directos"
          >
            <MessageSquare className="w-5 h-5" />
          </button>
          {totalDmUnread + groupUnreadTotal > 0 && (
            <span className="absolute -bottom-0.5 -right-0.5 min-w-[16px] h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1 pointer-events-none">
              {totalDmUnread + groupUnreadTotal > 99 ? '99+' : totalDmUnread + groupUnreadTotal}
            </span>
          )}
        </div>

        <div className="w-8 h-[2px] bg-white/10 rounded-full" />

        <div className="flex-1 w-full overflow-y-auto hide-scrollbar flex flex-col items-center gap-3">
          {servers?.map(server => {
            const mentions = [...notifications.mentionCounts].reduce((sum, [channelId, count]) =>
              sum + (channelMetadata.get(channelId)?.serverId === server.id ? count : 0), 0);
            return (
            <div key={server.id} className="relative group flex justify-center w-full">
              <div className={`absolute left-0 w-1 bg-primary rounded-r-full transition-all duration-200 ${activeView === 'servers' && activeServerId === server.id ? 'h-10 top-1' : 'h-2 top-5 opacity-0 group-hover:opacity-100 group-hover:h-5'}`} />
              <button
                onClick={() => {
                  setActiveView('servers');
                  setActiveServerId(server.id);
                  setShowClips(false);
                  setMobilePanelDepth(1);
                  setLocation('/app');
                }}
                className={`w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all overflow-hidden bg-secondary flex items-center justify-center border border-white/5 ${activeView === 'servers' && activeServerId === server.id ? 'rounded-[16px] bg-primary/20 text-primary border-primary/50 glow-effect' : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'}`}
                title={server.name}
              >
                {server.iconUrl
                  ? <img src={sameOriginUploadUrl(server.iconUrl)} className="w-full h-full object-cover" alt="" />
                  : <span className="font-mono font-bold">{server.name.substring(0, 2).toUpperCase()}</span>
                }
              </button>
              {mentions > 0 && (
                <span className="absolute -bottom-1 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1 pointer-events-none">
                  {mentions > 99 ? '99+' : mentions}
                </span>
              )}
            </div>
          ); })}
          
          <button
            onClick={() => setIsCreateServerOpen(true)}
            className="w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all bg-secondary border border-white/10 text-green-500 hover:bg-green-500/20 flex items-center justify-center group"
            title="Añadir Servidor"
          >
            <Plus className="w-6 h-6 group-hover:scale-110 transition-transform" />
          </button>

          <button
            onClick={() => setIsJoinByCodeOpen(true)}
            className="w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all bg-secondary border border-white/10 text-primary hover:bg-primary/20 flex items-center justify-center group"
            title="Unirse con código"
          >
            <Link2 className="w-5 h-5 group-hover:scale-110 transition-transform" />
          </button>
          <a
            href="https://anotherstore.neocities.org/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Abrir la tienda en una pestaña nueva"
            title="Tienda — se abre en una pestaña nueva"
            className="w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all bg-secondary border border-white/10 text-muted-foreground hover:bg-primary/20 hover:text-primary flex items-center justify-center group"
          >
            <ShoppingBag className="w-5 h-5 group-hover:scale-110 transition-transform" />
          </a>
          <a
            href="https://manuelbustamante-py.github.io/ScreenShare/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Películas — se abre en una pestaña nueva"
            title="Películas — se abre en una pestaña nueva"
            className="group flex flex-col items-center gap-1 text-muted-foreground hover:text-primary"
          >
            <span className="w-12 h-12 rounded-[24px] group-hover:rounded-[16px] transition-all bg-secondary border border-white/10 group-hover:bg-primary/20 flex items-center justify-center">
              <Clapperboard className="w-5 h-5 group-hover:scale-110 transition-transform" aria-hidden="true" />
            </span>
            <span className="text-[9px]">Películas</span>
          </a>
        </div>
      </div>

      {/* 2. LEFT COLUMN — Channels or DM conversations */}
      <div className={`${mobilePanelDepth === 1 ? 'flex w-full h-full' : 'hidden'} md:flex md:w-60 bg-card/50 border-r border-white/5 flex-col md:flex-shrink-0`}>
        {activeView === 'dms' ? (
          <>
            {/* DM header */}
            <div className="h-12 border-b border-white/5 flex items-center px-4 bg-card flex-shrink-0">
              <button className="md:hidden p-1 mr-1 text-muted-foreground hover:text-white rounded" onClick={() => setMobilePanelDepth(0)}>
                <ChevronLeft className="w-5 h-5" />
              </button>
              <MessageSquare className="w-4 h-4 text-primary mr-2" />
              <h2 className="font-bold text-foreground truncate flex-1">Mensajes directos</h2>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setDmSubView(v => v === 'friends' ? 'messages' : 'friends')}
                  className={`p-1.5 rounded-md transition-colors ${dmSubView === 'friends' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-white hover:bg-white/5'}`}
                  title="Amigos"
                >
                  <Bell className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowDmGroupModal(true)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-white hover:bg-white/5 transition-colors"
                  title="Nuevo grupo"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* DM conversation list */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {(!dmConversations || dmConversations.length === 0) && (
                <p className="text-xs text-muted-foreground text-center mt-4 font-mono">Sin conversaciones todavía</p>
              )}
              {(dmConversations as any[] ?? []).map((convo: any) => {
                const other = convo.otherUser;
                const unread = convo.unreadCount ?? 0;
                const isActive = !activeDmGroupId && activeDmUserId === other?.id;
                return (
                  <button
                    key={other?.id}
                    onClick={() => { setActiveDmGroupId(null); setActiveDmUserId(other?.id); setDmSubView('messages'); }}
                    className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm transition-colors ${isActive ? 'bg-primary/15 text-foreground glow-effect' : unread ? 'bg-primary/5 text-foreground font-semibold hover:bg-primary/10' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}
                  >
                    <div className="relative flex-shrink-0">
                      <div className="w-9 h-9 rounded-full bg-secondary overflow-hidden">
                        {other?.avatarUrl ? <AvatarImage url={other.avatarUrl} /> : <UsersIcon className="w-4 h-4 m-2.5 text-muted-foreground" />}
                      </div>
                      <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-card ${getStatusColor(other?.status ?? 'offline')}`} />
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-sm font-medium text-foreground truncate">{other?.displayName}</p>
                        {unread > 0 && (
                          <span className="min-w-[18px] h-[18px] bg-primary text-primary-foreground text-[10px] font-bold rounded-full flex items-center justify-center px-1 flex-shrink-0">
                            {unread > 99 ? '99+' : unread}
                          </span>
                        )}
                      </div>
                      {convo.lastMessage && (
                        <p className="text-xs text-muted-foreground truncate">
                          {convo.lastMessage.senderId === user.id ? 'Tú: ' : ''}{convo.lastMessage.content?.slice(0, 35)}{convo.lastMessage.content?.length > 35 ? '…' : ''}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
              {dmGroups.map(group => (
                <button
                  key={`group-${group.id}`}
                    onClick={() => { setActiveDmUserId(null); setActiveDmGroupId(group.id); setDmSubView('messages'); setMobilePanelDepth(2); }}
                  className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm transition-colors ${activeDmGroupId === group.id ? 'bg-primary/15 text-foreground glow-effect' : notifications.groupUnread.has(group.id) ? 'bg-primary/5 text-foreground font-semibold hover:bg-primary/10' : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground'}`}
                  aria-label={`Grupo ${group.name}`}
                >
                  <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                    <UsersIcon className="w-4 h-4" />
                  </div>
                  <span className="truncate font-medium flex-1 text-left">{group.name}</span>
                  {(notifications.groupUnread.get(group.id) ?? 0) > 0 && (
                    <span className="min-w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1">
                      {(notifications.groupUnread.get(group.id) ?? 0) > 99 ? '99+' : notifications.groupUnread.get(group.id)}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Compact call indicator (DM mode) */}
            {callStatusBar}

            {/* User Info Area */}
            <div className="h-16 bg-card border-t border-white/5 flex items-center px-3 gap-2">
              <button onClick={() => setIsProfileOpen(true)} className="relative group" title="Perfil">
                <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden">
                  {user.avatarUrl ? <AvatarImage url={user.avatarUrl} /> : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
                </div>
                <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-card ${getStatusColor(user.status)}`} />
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate leading-tight">{user.displayName}</p>
                <p className="text-xs text-muted-foreground font-mono truncate leading-tight">@{user.username}</p>
              </div>
              <button onClick={() => setIsSettingsOpen(true)} className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10 transition-colors" title="Ajustes">
                <Cog className="w-4 h-4" />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex-shrink-0">
              {activeServer?.bannerUrl && (
                <div className="w-full h-16 overflow-hidden flex-shrink-0">
                  <img src={sameOriginUploadUrl(activeServer.bannerUrl)} className="w-full h-full object-cover" alt="" />
                </div>
              )}
              <div className="h-12 border-b border-white/5 flex items-center px-4 justify-between bg-card">
                <h2 className="font-bold text-foreground truncate flex-1">{activeServer?.name || 'A.N.O.T.H.E.R.'}</h2>
                {activeServer && canManageServer && (
                  <button
                    onClick={() => setIsServerSettingsOpen(true)}
                    className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10 transition-colors flex-shrink-0"
                    title="Configuración del servidor"
                  >
                    <SlidersHorizontal className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Story bar */}
            <StoryBar currentUserId={user.id} currentUser={user} />

            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              <div className="flex items-center justify-between px-2 mb-1 group">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Canales</p>
                {activeServer && canCreateChannel && (
                  <button onClick={() => setIsCreateChannelOpen(true)} className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>
              
              {channels?.map(channel => {
                const channelType = (channel as any).channelType ?? 'text';
                if (channelType === 'voice') {
                  return (
                    <VoiceChannelRow
                      key={channel.id}
                      channel={channel}
                      isActive={activeChannelId === channel.id}
                      isJoined={webrtc.activeVoiceChannelId === channel.id}
                      onClick={() => {
                        setJoinedVoiceChannelName(channel.name);
                        if (webrtc.activeVoiceChannelId === channel.id) {
                          setActiveChannelId(channel.id);
                        } else {
                          setActiveChannelId(channel.id);
                          const currentMembers: any[] = [];
                          webrtc.joinVoiceChannel(channel.id, currentMembers);
                        }
                      }}
                    />
                  );
                }
                const ChannelIcon = CHANNEL_TYPE_ICON[channelType as keyof typeof CHANNEL_TYPE_ICON] ?? Hash;
                const vc = (channel as any).visualConfig ?? {};
                const hasVisual = vc.kind && vc.value;
                const channelUnread = unreadCounts.get(channel.id) ?? 0;
                const mentions = notifications.mentionCounts.get(channel.id) ?? 0;
                return (
                  <button
                    key={channel.id}
                    onClick={() => {
                      setActiveChannelId(channel.id);
                      setShowClips(false);
                      if (channelType === 'calendar') setShowMembers(false);
                      setMobilePanelDepth(2);
                    }}
                    data-testid={`channel-item-${channel.id}`}
                    aria-label={`${CHANNEL_TYPE_LABEL[channelType as keyof typeof CHANNEL_TYPE_LABEL] ?? 'Canal'}: ${channel.name}`}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors relative overflow-hidden ${activeChannelId === channel.id && !showClips ? 'bg-primary/15 text-foreground font-medium glow-effect' : channelUnread || mentions ? 'bg-primary/5 text-foreground font-semibold hover:bg-primary/10' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}
                    style={hasVisual && vc.kind === 'gradient'
                      ? { background: `linear-gradient(90deg, ${vc.value.split(',')[0]}, ${vc.value.split(',')[1] ?? vc.value.split(',')[0]})`, color: 'white' }
                      : hasVisual && vc.kind === 'image'
                      ? { backgroundImage: `url(${vc.value})`, backgroundSize: 'cover', backgroundPosition: 'center', color: 'white' }
                      : {}
                    }
                  >
                    {hasVisual && <div className="absolute inset-0 bg-black/30 rounded-md" />}
                    <ChannelIcon className="w-4 h-4 opacity-60 flex-shrink-0 relative z-10" />
                    <span className={`truncate relative z-10 ${channelUnread > 0 ? 'font-semibold text-foreground' : ''}`}>{channel.name}</span>
                    <span className="ml-auto flex items-center gap-1 relative z-10">
                      {(channel as any).restrictedRoles?.length > 0 && (
                        <span className="text-[10px] text-primary/60 font-mono">🔒</span>
                      )}
                      {channelUnread > 0 && (
                        <span className="min-w-[16px] h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                          {channelUnread > 99 ? '99+' : channelUnread}
                        </span>
                      )}
                      {mentions > 0 && (
                        <span className="min-w-[18px] h-4 bg-primary text-primary-foreground text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                          {mentions > 99 ? '99+' : `@${mentions}`}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}

              {/* Clips section */}
              {activeServerId && (
                <button
                  onClick={() => setShowClips(v => !v)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors mt-2 ${showClips ? 'bg-primary/15 text-foreground font-medium glow-effect' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}
                >
                  <Play className="w-4 h-4 opacity-60 flex-shrink-0" />
                  <span>Clips</span>
                </button>
              )}
            </div>

            {/* Compact call indicator (server mode) */}
            {callStatusBar}

            {/* User Info Area */}
            <div className="h-16 bg-card border-t border-white/5 flex items-center px-3 gap-2">
              <button onClick={() => setIsProfileOpen(true)} className="relative group" title="Perfil">
                <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden">
                  {user.avatarUrl ? <AvatarImage url={user.avatarUrl} /> : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
                </div>
                <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-card ${getStatusColor(user.status)}`} />
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate leading-tight">{user.displayName}</p>
                <p className="text-xs text-muted-foreground font-mono truncate leading-tight">@{user.username}</p>
              </div>
              <div className="flex gap-1">
                <button onClick={() => setIsSettingsOpen(true)} className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10 transition-colors" title="Ajustes">
                  <Cog className="w-4 h-4" />
                </button>
                {user.role === 'admin' && (
                  <button onClick={() => setLocation('/app/admin')} className="p-1.5 text-primary hover:text-primary rounded-md hover:bg-primary/20 transition-colors" title="Panel de Admin">
                    <ShieldAlert className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 3. CHAT / DM AREA */}
      <div className={`${mobilePanelDepth >= 2 ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-background min-w-0 relative`}>
        {/* ── Friends panel ─────────────────────────────────────────────── */}
        {activeView === 'dms' && dmSubView === 'friends' && (
          <FriendsPanel
            onOpenDm={uid => { setActiveDmGroupId(null); setActiveDmUserId(uid); setDmSubView('messages'); setMobilePanelDepth(2); }}
          />
        )}

        {/* ── DM chat pane ─────────────────────────────────────────────── */}
        {activeView === 'dms' && dmSubView === 'messages' && !activeDmGroupId && activeDmUserId && activeDmConvo && (
          <>
            {/* DM header */}
            <div className="h-12 border-b border-white/5 flex items-center px-4 bg-card/30 backdrop-blur-sm z-10 gap-3 flex-shrink-0">
              <button className="md:hidden p-1 -ml-1 text-muted-foreground hover:text-white rounded flex-shrink-0" onClick={() => setMobilePanelDepth(1)}>
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="relative flex-shrink-0">
                <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden">
                  {(activeDmConvo as any).otherUser?.avatarUrl
                    ? <AvatarImage url={(activeDmConvo as any).otherUser.avatarUrl} />
                    : <UsersIcon className="w-4 h-4 m-2 text-muted-foreground" />}
                </div>
                <div className={`absolute bottom-0 right-0 w-2 h-2 rounded-full border-2 border-card ${getStatusColor((activeDmConvo as any).otherUser?.status ?? 'offline')}`} />
              </div>
              <span className="font-semibold text-foreground">{(activeDmConvo as any).otherUser?.displayName}</span>
              <span className="text-xs text-muted-foreground font-mono">@{(activeDmConvo as any).otherUser?.username}</span>
              <div className="ml-auto flex items-center gap-1">
                {webrtc.callState === 'idle' && !webrtc.isInVoiceChannel && (
                  <button
                    onClick={() => webrtc.callUser(
                      (activeDmConvo as any).otherUser?.id,
                      user.displayName,
                      user.avatarUrl,
                    )}
                    className="p-2 text-muted-foreground hover:text-green-400 hover:bg-green-500/10 rounded-lg transition-colors"
                    title="Llamar"
                  >
                    <Phone className="w-4 h-4" />
                  </button>
                )}
                {(webrtc.callState === 'calling' || webrtc.callState === 'connected') && webrtc.dmCallUserId === (activeDmConvo as any).otherUser?.id && (
                  <button
                    onClick={() => webrtc.endCall()}
                    className="p-2 text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-lg transition-colors"
                    title="Colgar"
                  >
                    <PhoneOff className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* DM messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-0">
              {(dmMessages as any[] ?? []).map((msg: any, idx: number) => {
                const list = dmMessages as any[] ?? [];
                const isFirst = idx === 0 || list[idx - 1].senderId !== msg.senderId || new Date(msg.createdAt).getTime() - new Date(list[idx - 1].createdAt).getTime() > 300000;
                const isOwn = msg.senderId === user.id;
                return (
                  <div
                    key={msg.id}
                    className={`group flex gap-4 hover:bg-white/[0.02] rounded-lg px-2 -mx-2 transition-colors ${isFirst ? 'mt-3 pt-0.5' : 'mt-0.5'}`}
                  >
                    {isFirst ? (
                      <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all mt-0.5"
                        onClick={e => openProfileCard(msg.senderId, e)}>
                        {msg.sender?.avatarUrl ? <AvatarImage url={msg.sender.avatarUrl} /> : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
                      </div>
                    ) : (
                      <div className="w-10 flex-shrink-0 opacity-0 group-hover:opacity-100 text-[10px] text-muted-foreground font-mono text-center self-start pt-1">
                        {format(new Date(msg.createdAt), 'HH:mm')}
                      </div>
                    )}
                    <div className="flex-1 min-w-0 pb-1">
                      {isFirst && (
                        <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                          <span className="font-medium text-foreground hover:underline cursor-pointer" onClick={e => openProfileCard(msg.senderId, e)}>{msg.sender?.displayName ?? 'Usuario'}</span>
                          <span className="text-xs text-muted-foreground font-mono">{format(new Date(msg.createdAt), "dd/MM/yyyy HH:mm")}</span>
                        </div>
                      )}
                      {msg.replyTo && !msg.deletedAt && (
                        <div className="mb-1 flex items-start gap-1.5 text-xs text-muted-foreground border-l-2 border-primary/50 pl-2 py-0.5">
                          <CornerUpLeft className="w-3 h-3 flex-shrink-0 mt-0.5 text-primary" />
                          <span className="text-primary font-medium mr-1">{msg.replyTo.authorDisplayName}</span>
                          <span className="truncate">{msg.replyTo.contentPreview}</span>
                        </div>
                      )}
                      <div className="relative flex items-start justify-between gap-2">
                        <div className="text-sm text-foreground/90 whitespace-pre-wrap leading-normal min-w-0 pr-12 md:pr-0">
                          {msg.deletedAt
                            ? <span className="text-muted-foreground italic font-mono">[mensaje eliminado]</span>
                            : <GifMessage content={msg.content} />}
                        </div>
                        {!msg.deletedAt && isOwn && (
                           <div className={`absolute right-0 top-0 ${mobileMessageActions === `dm:${msg.id}` ? 'z-30' : 'z-20'} md:static md:z-auto md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity`}>
                             <button type="button" aria-label="Más acciones del mensaje" aria-expanded={mobileMessageActions === `dm:${msg.id}`} onClick={() => setMobileMessageActions(mobileMessageActions === `dm:${msg.id}` ? null : `dm:${msg.id}`)} className="flex h-11 w-11 items-center justify-center text-muted-foreground bg-card border border-border rounded-md md:hidden"><MoreVertical className="w-4 h-4" /></button>
                             <div className={`${mobileMessageActions === `dm:${msg.id}` ? 'flex' : 'hidden'} md:flex absolute right-0 top-11 md:static items-center flex-wrap justify-end max-w-[calc(100vw-2rem)] md:max-w-none md:flex-nowrap [&_button]:min-h-11 [&_button]:min-w-11 md:[&_button]:min-h-0 md:[&_button]:min-w-0 bg-card border border-border rounded-md flex-shrink-0`}>
                            <QuickReactionButtons onSelect={emoji => handleDmReact(msg.id, emoji)} />
                            <button type="button" onClick={() => setDmEmojiPickerMsgId(dmEmojiPickerMsgId === msg.id ? null : msg.id)} className="p-1.5 text-muted-foreground hover:text-primary" title="Más emojis" aria-label="Elegir reacción">
                              <Smile className="w-3.5 h-3.5" />
                            </button>
                            {dmEmojiPickerMsgId === msg.id && <EmojiPicker onSelect={emoji => handleDmReact(msg.id, emoji)} onClose={() => setDmEmojiPickerMsgId(null)} />}
                            <button onClick={() => setDmReplyingTo(msg)} className="p-1.5 text-muted-foreground hover:bg-white/10 hover:text-primary transition-colors" title="Responder">
                              <CornerUpLeft className="w-3.5 h-3.5" />
                            </button>
                            <div className="w-[1px] h-4 bg-white/10" />
                            <button onClick={() => deleteDm.mutate({ dmId: msg.id })} className="p-1.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors" title="Eliminar">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            </div>
                          </div>
                        )}
                        {!msg.deletedAt && !isOwn && (
                           <div className={`absolute right-0 top-0 ${mobileMessageActions === `dm:${msg.id}` ? 'z-30' : 'z-20'} md:static md:z-auto md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity`}>
                             <button type="button" aria-label="Más acciones del mensaje" aria-expanded={mobileMessageActions === `dm:${msg.id}`} onClick={() => setMobileMessageActions(mobileMessageActions === `dm:${msg.id}` ? null : `dm:${msg.id}`)} className="flex h-11 w-11 items-center justify-center text-muted-foreground bg-card border border-border rounded-md md:hidden"><MoreVertical className="w-4 h-4" /></button>
                             <div className={`${mobileMessageActions === `dm:${msg.id}` ? 'flex' : 'hidden'} md:flex absolute right-0 top-11 md:static items-center flex-wrap justify-end max-w-[calc(100vw-2rem)] md:max-w-none md:flex-nowrap [&_button]:min-h-11 [&_button]:min-w-11 md:[&_button]:min-h-0 md:[&_button]:min-w-0 bg-card border border-border rounded-md flex-shrink-0`}>
                            <QuickReactionButtons onSelect={emoji => handleDmReact(msg.id, emoji)} />
                            <button type="button" onClick={() => setDmEmojiPickerMsgId(dmEmojiPickerMsgId === msg.id ? null : msg.id)} className="p-1.5 text-muted-foreground hover:text-primary" title="Más emojis" aria-label="Elegir reacción">
                              <Smile className="w-3.5 h-3.5" />
                            </button>
                            {dmEmojiPickerMsgId === msg.id && <EmojiPicker onSelect={emoji => handleDmReact(msg.id, emoji)} onClose={() => setDmEmojiPickerMsgId(null)} />}
                            <button onClick={() => setDmReplyingTo(msg)} className="p-1.5 text-muted-foreground hover:bg-white/10 hover:text-primary transition-colors" title="Responder">
                              <CornerUpLeft className="w-3.5 h-3.5" />
                            </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {!msg.deletedAt && (
                        <ReactionIndicators
                          reactions={msg.reactions}
                          currentUserId={user.id}
                          onToggle={emoji => handleDmReact(msg.id, emoji)}
                          isPending={emoji => pendingReactions.has(`dm:${msg.id}:${emoji}`)}
                          getName={id => id === user.id ? user.displayName : id === (activeDmConvo as any).otherUser?.id ? (activeDmConvo as any).otherUser.displayName : `Usuario ${id}`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={dmMessagesEndRef} />
            </div>

            {/* DM input */}
            <div className="p-4 pt-0">
              <div className="h-6 flex items-end px-2">
                {dmTypingUsers.size > 0 && (
                  <span className="text-xs text-primary font-mono animate-pulse">
                    {(activeDmConvo as any).otherUser?.displayName} está escribiendo...
                  </span>
                )}
              </div>
              {dmReplyingTo && (
                <div className="flex items-center justify-between bg-secondary border border-white/10 rounded-t-xl px-4 py-2 text-xs border-b-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <CornerUpLeft className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                    <span className="text-muted-foreground">Respondiendo a</span>
                    <span className="text-primary font-medium truncate">{dmReplyingTo.sender?.displayName ?? 'Usuario'}</span>
                    <span className="text-muted-foreground truncate">— {dmReplyingTo.content?.slice(0, 60)}{dmReplyingTo.content?.length > 60 ? '…' : ''}</span>
                  </div>
                  <button onClick={() => setDmReplyingTo(null)} className="text-muted-foreground hover:text-white flex-shrink-0 ml-2">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <form
                onSubmit={handleSendDm}
                className={`relative flex items-center bg-card border border-white/10 ${dmReplyingTo ? 'rounded-b-xl rounded-t-none border-t-0' : 'rounded-xl'}`}
              >
                <button type="button" onClick={() => { setComposerGifPicker(null); setComposerEmojiPicker(composerEmojiPicker === 'dm' ? null : 'dm'); }} className="p-3 text-muted-foreground hover:text-primary" title="Insertar emoji" aria-label="Insertar emoji">
                  <Smile className="w-5 h-5" />
                </button>
                {composerEmojiPicker === 'dm' && <EmojiPicker onSelect={emoji => insertEmojiAtCursor(dmInputRef.current, dmInput, emoji, setDmInput)} onClose={() => setComposerEmojiPicker(null)} />}
                <button type="button" data-testid="button-dm-gif" onClick={() => { setComposerEmojiPicker(null); setComposerGifPicker(composerGifPicker === 'dm' ? null : 'dm'); }} className="p-2 text-xs font-semibold text-muted-foreground hover:text-primary" title="Buscar GIF" aria-label="Buscar GIF">GIF</button>
                {composerGifPicker === 'dm' && <GifPicker onSelect={gif => sendDmContent(serializeGiphyMessage(gif.url), true)} onClose={() => setComposerGifPicker(null)} />}
                <input
                  ref={dmInputRef}
                  type="text"
                  value={dmInput}
                  onChange={handleDmInputChange}
                  placeholder={`Mensaje a ${(activeDmConvo as any).otherUser?.displayName}...`}
                  className="flex-1 min-w-0 bg-transparent px-4 py-3.5 text-foreground placeholder:text-muted-foreground focus:outline-none font-sans"
                  onKeyDown={e => { if (e.key === 'Escape' && dmReplyingTo) setDmReplyingTo(null); }}
                />
                <button type="submit" disabled={!dmInput.trim() || sendDm.isPending} className="p-3 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50">
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </>
        )}

        {/* DM mode — no conversation selected */}
        {activeView === 'dms' && dmSubView === 'messages' && !activeDmUserId && !activeDmGroupId && (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
            <MessageSquare className="w-16 h-16 opacity-20" />
            <p>Selecciona una conversación o haz clic en "Mensaje directo" en el perfil de alguien.</p>
          </div>
        )}

        {/* DM mode — conversation selected but not in list (first message) */}
        {activeView === 'dms' && dmSubView === 'messages' && !activeDmGroupId && activeDmUserId && !activeDmConvo && (
          <>
            <div className="h-12 border-b border-white/5 flex items-center px-4 bg-card/30 backdrop-blur-sm z-10">
              <span className="font-semibold text-foreground">Nueva conversación</span>
            </div>
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
              <MessageSquare className="w-12 h-12 opacity-20" />
              <p className="text-sm">Inicia la conversación enviando el primer mensaje.</p>
            </div>
            <div className="p-4 pt-0">
              <div className="h-6" />
              <form onSubmit={handleSendDm} className="relative flex items-center bg-card border border-white/10 rounded-xl">
                <button type="button" onClick={() => { setComposerGifPicker(null); setComposerEmojiPicker(composerEmojiPicker === 'dm' ? null : 'dm'); }} className="p-3 text-muted-foreground hover:text-primary" title="Insertar emoji" aria-label="Insertar emoji">
                  <Smile className="w-5 h-5" />
                </button>
                {composerEmojiPicker === 'dm' && <EmojiPicker onSelect={emoji => insertEmojiAtCursor(dmInputRef.current, dmInput, emoji, setDmInput)} onClose={() => setComposerEmojiPicker(null)} />}
                <button type="button" data-testid="button-new-dm-gif" onClick={() => { setComposerEmojiPicker(null); setComposerGifPicker(composerGifPicker === 'dm' ? null : 'dm'); }} className="p-2 text-xs font-semibold text-muted-foreground hover:text-primary" title="Buscar GIF" aria-label="Buscar GIF">GIF</button>
                {composerGifPicker === 'dm' && <GifPicker onSelect={gif => sendDmContent(serializeGiphyMessage(gif.url), true)} onClose={() => setComposerGifPicker(null)} />}
                <input
                  ref={dmInputRef}
                  type="text"
                  value={dmInput}
                  onChange={handleDmInputChange}
                  placeholder="Escribe un mensaje..."
                    className="flex-1 min-w-0 bg-transparent px-4 py-3.5 text-foreground placeholder:text-muted-foreground focus:outline-none font-sans"
                />
                <button type="submit" disabled={!dmInput.trim() || sendDm.isPending} className="p-3 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50">
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </>
        )}

        {activeView === 'dms' && dmSubView === 'messages' && activeDmGroupId && dmGroups.find(group => group.id === activeDmGroupId) && (
          <DmGroupConversation
            key={activeDmGroupId}
            groupId={activeDmGroupId}
            groupName={dmGroups.find(group => group.id === activeDmGroupId)!.name}
            currentUserId={user.id}
            onBack={() => setMobilePanelDepth(1)}
          />
        )}

        {/* ── Server / channel chat pane ──────────────────────────────── */}
        {/* ── Clips view ──────────────────────────────────────────────── */}
        {activeView === 'servers' && showClips && activeServerId ? (
          <ClipsView serverId={activeServerId} currentUserId={user.id} />
        ) : activeView === 'servers' && activeChannel ? (
          <>
            {/* Mute status banner */}
            {muteStatus && (
              <div className="flex items-center gap-2 px-4 py-2 bg-orange-500/10 border-b border-orange-500/20 text-sm flex-shrink-0">
                <span>🔇</span>
                <span className="text-orange-300">Estás silenciado hasta {new Date(muteStatus.expiresAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</span>
                {muteStatus.reason && <span className="text-muted-foreground">— {muteStatus.reason}</span>}
              </div>
            )}

            {/* Channel header */}
            <div className="h-12 border-b border-white/5 flex items-center px-4 justify-between bg-card/30 backdrop-blur-sm z-10">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-foreground font-medium">
                <button className="md:hidden p-1 -ml-1 text-muted-foreground hover:text-white rounded" onClick={() => setMobilePanelDepth(1)}>
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <ActiveChannelIcon className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{activeChannel.name}</span>
                {(activeChannel as any).restrictedRoles?.length > 0 && (
                  <span className="text-xs text-primary/60 font-mono">🔒 restringido</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {activeChannelType !== 'calendar' && <button
                  onClick={() => setShowSearch(true)}
                  className="p-1.5 text-muted-foreground hover:text-white hover:bg-white/5 rounded-md transition-colors"
                  title="Buscar mensajes"
                >
                  <Search className="w-4 h-4" />
                </button>}
                {activeChannelType === 'text' && <ChannelEventsEntry
                  channelName={activeChannel.name}
                  open={showEvents}
                  onClick={() => {
                    const next = !showEvents;
                    setShowEvents(next);
                    if (next) setShowMembers(false);
                  }}
                />}
                <button 
                  onClick={() => {
                    if (!desktopLayout) {
                      if (mobileMembersOpen) closeMobileMembers();
                      else setMobileMembersOpen(true);
                      return;
                    }
                    const next = !showMembers;
                    setShowMembers(next);
                    if (next) setShowEvents(false);
                  }}
                  className={`p-1.5 rounded-md transition-colors ${(desktopLayout ? showMembers : mobileMembersOpen) ? 'bg-white/10 text-white' : 'text-muted-foreground hover:bg-white/5 hover:text-white'}`}
                  title="Miembros"
                  aria-label="Miembros"
                  aria-expanded={desktopLayout ? showMembers : mobileMembersOpen}
                >
                  <UsersIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            {activeChannelType === 'calendar' ? (
              <ChannelEventsPanel
                key={activeChannel.id}
                channelId={activeChannel.id}
                onClose={() => {}}
                currentUser={user}
                userPermissions={myPermissions}
                layout="main"
              />
            ) : activeChannelType === 'media' ? (
              <ChannelFilesPanel
                channelId={activeChannel.id}
                currentUser={user}
                permissions={myPermissions}
              />
            ) : (
              <>
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-0">
              {messages?.map((msg, idx) => {
                const isFirst = idx === 0 || messages[idx - 1].userId !== msg.userId || new Date(msg.createdAt).getTime() - new Date(messages[idx - 1].createdAt).getTime() > 300000;
                const isOwn = msg.userId === user.id;
                const msgAny = msg as any;

                let contentToRender = msg.content;
                let announcedEventId: number | null = null;
                if (contentToRender && !msg.deletedAt && !parseGiphyMessage(contentToRender)) {
                  const match = contentToRender.match(/\[event:(\d+)\]/);
                  if (match) {
                    announcedEventId = parseInt(match[1], 10);
                    contentToRender = contentToRender.replace(/\[event:\d+\]/, '').trim();
                  }
                }

                return (
                  <div
                    key={msg.id}
                    ref={el => { if (el) messageRefs.current.set(msg.id, el); else messageRefs.current.delete(msg.id); }}
                    className={`group flex gap-4 hover:bg-white/[0.02] rounded-lg px-2 -mx-2 transition-colors ${isFirst ? 'mt-3 pt-0.5' : 'mt-0.5'}`}
                  >
                    {isFirst ? (
                      <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all mt-0.5" onClick={e => openProfileCard(msg.userId, e)}>
                        {msgAny.author?.avatarUrl ? <AvatarImage url={msgAny.author.avatarUrl} /> : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
                      </div>
                    ) : (
                      <div className="w-10 flex-shrink-0 opacity-0 group-hover:opacity-100 text-[10px] text-muted-foreground font-mono text-center self-start pt-1">
                        {format(new Date(msg.createdAt), 'HH:mm')}
                      </div>
                    )}
                    
                    <div className="flex-1 min-w-0 pb-1">
                      {isFirst && (
                        <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                          <span className="font-medium text-foreground hover:underline cursor-pointer" onClick={e => openProfileCard(msg.userId, e)}>{msgAny.author?.displayName ?? 'Usuario'}</span>
                          <span className="text-xs text-muted-foreground font-mono">{format(new Date(msg.createdAt), "dd/MM/yyyy HH:mm")}</span>
                        </div>
                      )}

                      {/* Reply quote */}
                      {msgAny.replyTo && !msg.deletedAt && (
                        <ReplyQuote replyTo={msgAny.replyTo} onClick={() => scrollToMessage(msgAny.replyTo.id)} />
                      )}
                      
                        <div className="relative flex items-start justify-between gap-2">
                        {editingMessageId === msg.id ? (
                          <form onSubmit={handleEditMessage} className="w-full relative">
                            <input 
                              type="text"
                              value={editInput}
                              onChange={e => setEditInput(e.target.value)}
                              className="w-full bg-secondary border border-white/10 rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                              autoFocus
                              onKeyDown={e => { if (e.key === 'Escape') { setEditingMessageId(null); setEditInput(''); } }}
                            />
                            <div className="text-xs text-muted-foreground mt-1">Esc para cancelar, Enter para guardar</div>
                          </form>
                        ) : (
                           <div className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed min-w-0 pr-12 md:pr-0">
                            {msg.deletedAt ? (
                              <span className="text-muted-foreground italic font-mono">[mensaje eliminado]</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {contentToRender && contentToRender.trim() !== '' && (
                                  <div>
                                     <GifMessage content={contentToRender} />
                                    {msg.editedAt && <span className="text-[10px] text-muted-foreground ml-2 font-mono">(editado)</span>}
                                  </div>
                                )}
                                {announcedEventId && (
                                  <EventMessageCard
                                    eventId={announcedEventId}
                                    channelId={activeChannel.id}
                                    onOpenEvents={() => {
                                      setShowEvents(true);
                                      setShowMembers(false);
                                    }}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Hover action bar */}
                        {!msg.deletedAt && editingMessageId !== msg.id && (
                           <div className={`absolute right-0 top-0 ${mobileMessageActions === `channel:${msg.id}` ? 'z-30' : 'z-20'} md:static md:z-auto md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity`}>
                             <button type="button" aria-label="Más acciones del mensaje" aria-expanded={mobileMessageActions === `channel:${msg.id}`} onClick={() => setMobileMessageActions(mobileMessageActions === `channel:${msg.id}` ? null : `channel:${msg.id}`)} className="flex h-11 w-11 items-center justify-center text-muted-foreground bg-card border border-border rounded-md md:hidden"><MoreVertical className="w-4 h-4" /></button>
                             <div className={`${mobileMessageActions === `channel:${msg.id}` ? 'flex' : 'hidden'} md:flex absolute right-0 top-11 md:static items-center flex-wrap justify-end max-w-[calc(100vw-2rem)] md:max-w-none md:flex-nowrap [&_button]:min-h-11 [&_button]:min-w-11 md:[&_button]:min-h-0 md:[&_button]:min-w-0 bg-card border border-border rounded-md flex-shrink-0`}>
                            {/* React */}
                            <QuickReactionButtons onSelect={emoji => handleReact(msg.id, emoji)} />
                            <div className="relative" onClick={e => e.stopPropagation()}>
                              <button
                                onClick={() => setEmojiPickerMsgId(emojiPickerMsgId === msg.id ? null : msg.id)}
                                className="p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
                                title="Más emojis"
                                aria-label="Elegir reacción"
                              >
                                <Smile className="w-3.5 h-3.5" />
                              </button>
                              {emojiPickerMsgId === msg.id && (
                                <EmojiPicker
                                  onSelect={emoji => handleReact(msg.id, emoji)}
                                  onClose={() => setEmojiPickerMsgId(null)}
                                />
                              )}
                            </div>
                            <div className="w-[1px] h-4 bg-white/10" />
                            {/* Reply */}
                            <button
                              onClick={() => setReplyingTo(msg)}
                              className="p-1.5 text-muted-foreground hover:bg-white/10 hover:text-primary transition-colors"
                              title="Responder"
                            >
                              <CornerUpLeft className="w-3.5 h-3.5" />
                            </button>
                            {(isOwn || hasPerm(myPermissions, PERM.MANAGE_MESSAGES) || canManageServer) && (
                              <>
                                <div className="w-[1px] h-4 bg-white/10" />
                                {isOwn && (
                                  <button onClick={() => { setEditingMessageId(msg.id); setEditInput(msg.content); }} className="p-1.5 text-muted-foreground hover:bg-white/10 hover:text-white transition-colors" title="Editar">
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                <button onClick={() => activeChannelId && deleteMessage.mutate({ channelId: activeChannelId, messageId: msg.id })} className="p-1.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors" title="Eliminar">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                            {!isOwn && (
                              <>
                                <div className="w-[1px] h-4 bg-white/10" />
                                <button
                                  onClick={() => setReportTarget({ messageId: msg.id, authorName: (msgAny.author?.displayName ?? 'Usuario') })}
                                  className="p-1.5 text-muted-foreground hover:bg-orange-400/20 hover:text-orange-400 transition-colors"
                                  title="Reportar mensaje"
                                >
                                  <Flag className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Attachments */}
                      {!msg.deletedAt && msgAny.attachments?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {msgAny.attachments.map((att: any) => (
                            <AttachmentRenderer key={att.id} attachment={att} />
                          ))}
                        </div>
                      )}

                      {/* Link preview */}
                      {!msg.deletedAt && msgAny.linkPreview && !dismissedPreviews.has(msg.id) && (
                        <LinkPreviewCard
                          preview={msgAny.linkPreview}
                          onDismiss={() => setDismissedPreviews(prev => new Set([...prev, msg.id]))}
                        />
                      )}

                      {!msg.deletedAt && (
                        <ReactionIndicators
                          reactions={msgAny.reactions}
                          currentUserId={user.id}
                          onToggle={emoji => handleReact(msg.id, emoji)}
                          isPending={emoji => pendingReactions.has(`channel:${msg.id}:${emoji}`)}
                          getName={id => id === user.id ? user.displayName : members?.find(member => member.userId === id)?.user.displayName ?? `Usuario ${id}`}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="p-4 pt-0">
              <div className="h-6 flex items-end px-2">
                {typingUsers.size > 0 && (
                  <span className="text-xs text-primary font-mono animate-pulse">
                    {typingUsers.size === 1 ? 'Alguien está escribiendo...' : 'Varios operarios están escribiendo...'}
                  </span>
                )}
              </div>

              {/* Reply banner */}
              {replyingTo && (
                <div className="flex items-center justify-between bg-secondary border border-white/10 rounded-t-xl px-4 py-2 text-xs border-b-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <CornerUpLeft className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                    <span className="text-muted-foreground">Respondiendo a</span>
                    <span className="text-primary font-medium truncate">{(replyingTo as any).author?.displayName ?? 'Usuario'}</span>
                    <span className="text-muted-foreground truncate">— {replyingTo.content?.slice(0, 60)}{replyingTo.content?.length > 60 ? '…' : ''}</span>
                  </div>
                  <button onClick={() => setReplyingTo(null)} className="text-muted-foreground hover:text-white flex-shrink-0 ml-2">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Pending file previews */}
              {pendingFiles.length > 0 && (
                <div className={`flex flex-wrap gap-2 bg-secondary border border-white/10 px-4 py-3 border-b-0 ${replyingTo ? '' : 'rounded-t-xl'}`}>
                  {pendingFiles.map((file, idx) => (
                    <div key={idx} className="relative group/file">
                      {file.type.startsWith('image/') ? (
                        <img
                          src={URL.createObjectURL(file)}
                          alt={file.name}
                          className="w-16 h-16 rounded-lg object-cover border border-white/10"
                        />
                      ) : (
                        <div className="w-16 h-16 rounded-lg bg-card border border-white/10 flex flex-col items-center justify-center gap-1">
                          <FileText className="w-6 h-6 text-primary" />
                          <span className="text-[9px] text-muted-foreground truncate w-12 text-center">{file.name}</span>
                        </div>
                      )}
                      <button
                        onClick={() => removePendingFile(idx)}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-destructive rounded-full flex items-center justify-center opacity-0 group-hover/file:opacity-100 transition-opacity"
                      >
                        <X className="w-2.5 h-2.5 text-white" />
                      </button>
                      {uploadingFile && idx === pendingFiles.length - 1 && (
                        <div className="absolute inset-0 rounded-lg bg-black/50 flex items-center justify-center">
                          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Mention autocomplete */}
              {mentionSuggestions.length > 0 && (
                <MentionList
                  suggestions={mentionSuggestions}
                  selectedIndex={selectedMentionIdx}
                  onSelect={m => {
                    const r = insertMention(m, messageInput, mentionCursorPos);
                    setMessageInput(r.newValue);
                    setMentionCursorPos(r.newCursor);
                    setSelectedMentionIdx(0);
                    msgInputRef.current?.focus();
                  }}
                />
              )}

            {/* Input form */}
              <form
                onSubmit={handleSendMessage}
                className={`relative flex items-center bg-card border border-white/10 ${(replyingTo || pendingFiles.length > 0) ? 'rounded-b-xl rounded-t-none border-t-0' : 'rounded-xl'}`}
              >
                {/* Clip button */}
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/*,video/*,.pdf,.doc,.docx,.txt,.zip"
                  multiple
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingFile}
                  className="p-3 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                  title="Adjuntar archivo"
                >
                  <Paperclip className="w-5 h-5" />
                </button>

                <button type="button" onClick={() => { setComposerGifPicker(null); setComposerEmojiPicker(composerEmojiPicker === 'channel' ? null : 'channel'); }} className="p-3 text-muted-foreground hover:text-primary" title="Insertar emoji" aria-label="Insertar emoji">
                  <Smile className="w-5 h-5" />
                </button>
                {composerEmojiPicker === 'channel' && (
                  <EmojiPicker
                    onSelect={emoji => insertEmojiAtCursor(msgInputRef.current, messageInput, emoji, value => {
                      setMessageInput(value);
                      setMentionCursorPos(msgInputRef.current?.selectionStart ?? value.length);
                    })}
                    onClose={() => setComposerEmojiPicker(null)}
                  />
                )}
                <button type="button" data-testid="button-channel-gif" onClick={() => { setComposerEmojiPicker(null); setComposerGifPicker(composerGifPicker === 'channel' ? null : 'channel'); }} className="p-2 text-xs font-semibold text-muted-foreground hover:text-primary" title="Buscar GIF" aria-label="Buscar GIF">GIF</button>
                {composerGifPicker === 'channel' && <GifPicker onSelect={gif => sendChannelContent(serializeGiphyMessage(gif.url), true)} onClose={() => setComposerGifPicker(null)} />}
                <input 
                  ref={msgInputRef}
                  type="text"
                  value={messageInput}
                  onChange={e => { handleMessageChange(e); setMentionCursorPos(e.target.selectionStart ?? 0); setSelectedMentionIdx(0); }}
                  onSelect={e => setMentionCursorPos((e.target as HTMLInputElement).selectionStart ?? 0)}
                  placeholder={`Escribir en #${activeChannel.name}...`}
                  className="flex-1 min-w-0 bg-transparent py-3.5 text-foreground placeholder:text-muted-foreground focus:outline-none font-sans"
                  onKeyDown={e => {
                    if (mentionSuggestions.length > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedMentionIdx(i => Math.min(i + 1, mentionSuggestions.length - 1)); return; }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedMentionIdx(i => Math.max(i - 1, 0)); return; }
                      if (e.key === 'Enter') { e.preventDefault(); const m = mentionSuggestions[selectedMentionIdx]; if (m) { const r = insertMention(m, messageInput, mentionCursorPos); setMessageInput(r.newValue); setMentionCursorPos(r.newCursor); setSelectedMentionIdx(0); } return; }
                      if (e.key === 'Escape') { setMentionCursorPos(-1); return; }
                    }
                    if (e.key === 'Escape' && replyingTo) setReplyingTo(null);
                  }}
                />

                <button 
                  type="submit" 
                  disabled={(!messageInput.trim() && pendingAttachmentIds.length === 0) || sendMessage.isPending || uploadingFile}
                  className="p-3 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
            </>
            )}
          </>
        ) : activeView === 'servers' ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <Hash className="w-16 h-16 opacity-20 mb-4" />
            <p>Selecciona o crea un canal para comenzar.</p>
          </div>
        ) : null}
      </div>

      {/* 4. MEMBER LIST COLUMN — only in server mode */}
      {activeView === 'servers' && activeChannel && (showMembers || mobileMembersOpen) && (
        <>
        {mobileMembersOpen && <button type="button" aria-label="Cerrar lista de miembros" onClick={closeMobileMembers} className="fixed inset-0 z-30 bg-black/60 md:hidden" />}
        <div className={`${mobileMembersOpen ? 'flex' : 'hidden'} ${showMembers ? 'md:flex' : 'md:hidden'} fixed inset-y-0 right-0 z-40 w-60 bg-card/95 border-l border-white/5 flex-col shadow-2xl md:static md:z-auto md:bg-card/30 md:shadow-none md:flex-shrink-0`}>
          <div className="flex justify-end border-b border-white/5 p-2 md:hidden">
            <button type="button" aria-label="Cerrar miembros" onClick={closeMobileMembers} className="p-2 text-muted-foreground hover:text-white"><X className="w-5 h-5" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {groupedMembers.online.length > 0 && (
              <div>
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Conectados — {groupedMembers.online.length}</h3>
                <div className="space-y-1">
                  {groupedMembers.online.map(member => (
                    <button
                      key={member.id}
                      onClick={e => openProfileCard(member.userId, e)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors"
                    >
                      <div className="relative flex-shrink-0">
                        <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden">
                          {member.user.avatarUrl ? <AvatarImage url={member.user.avatarUrl} /> : <UsersIcon className="w-4 h-4 m-2 text-muted-foreground" />}
                        </div>
                        <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-card ${getStatusColor(member.user.status)}`} />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-sm text-foreground truncate">{member.user.displayName}</p>
                        {member.role !== 'member' && (
                          <p className="text-[10px] text-primary font-mono capitalize">{member.role}</p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {groupedMembers.offline.length > 0 && (
              <div>
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Desconectados — {groupedMembers.offline.length}</h3>
                <div className="space-y-1">
                  {groupedMembers.offline.map(member => (
                    <button
                      key={member.id}
                      onClick={e => openProfileCard(member.userId, e)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors opacity-50"
                    >
                      <div className="relative flex-shrink-0">
                        <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden">
                          {member.user.avatarUrl ? <AvatarImage url={member.user.avatarUrl} /> : <UsersIcon className="w-4 h-4 m-2 text-muted-foreground" />}
                        </div>
                        <div className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-card ${getStatusColor(member.user.status)}`} />
                      </div>
                      <p className="text-sm text-foreground truncate flex-1 text-left">{member.user.displayName}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        </>
      )}

      {/* 5. EVENTS LIST COLUMN — only in server mode */}
      {activeView === 'servers' && showEvents && activeChannel && activeChannelType === 'text' && (
        <ChannelEventsPanel
          key={activeChannel.id}
          channelId={activeChannel.id}
          onClose={() => setShowEvents(false)}
          currentUser={user}
          userPermissions={myPermissions}
        />
      )}

      {/* Join by invite overlay */}
      {isJoinByCodeOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-card border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-foreground">Unirse con código</h3>
              <button onClick={() => setIsJoinByCodeOpen(false)} className="text-muted-foreground hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleJoinByCode} className="space-y-4">
              <input
                type="text"
                value={joinCode}
                onChange={e => setJoinCode(e.target.value)}
                placeholder="Código de invitación..."
                className="w-full bg-secondary border border-white/10 rounded-xl px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary font-mono"
                autoFocus
              />
              <button type="submit" disabled={!joinCode.trim() || joinByInvite.isPending} className="w-full py-3 bg-primary text-primary-foreground rounded-xl font-medium disabled:opacity-50 transition-opacity">
                {joinByInvite.isPending ? 'Uniéndose...' : 'Unirse'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── Incoming DM call toast ───────────────────────────────────────── */}
      {webrtc.incomingCall && (
        <div className="fixed bottom-24 left-4 z-50 bg-card border border-white/10 rounded-2xl shadow-2xl p-4 w-72 animate-in slide-in-from-bottom-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden flex-shrink-0">
              {webrtc.incomingCall.callerAvatar
                ? <AvatarImage url={webrtc.incomingCall.callerAvatar} />
                : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">{webrtc.incomingCall.callerName}</p>
              <p className="text-xs text-muted-foreground font-mono animate-pulse">Llamada entrante...</p>
            </div>
            <PhoneIncoming className="w-5 h-5 text-green-400 animate-pulse flex-shrink-0" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => webrtc.acceptCall()}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-green-500 hover:bg-green-600 text-white rounded-xl text-sm font-medium transition-colors"
            >
              <Phone className="w-4 h-4" />
              Aceptar
            </button>
            <button
              onClick={() => webrtc.rejectCall()}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-xl text-sm font-medium transition-colors"
            >
              <PhoneOff className="w-4 h-4" />
              Rechazar
            </button>
          </div>
        </div>
      )}

      {/* ── Calling toast (outgoing) ──────────────────────────────────────── */}
      {webrtc.callState === 'calling' && (
        <div className="fixed bottom-24 left-4 z-50 bg-card border border-white/10 rounded-2xl shadow-2xl p-4 w-64">
          <div className="flex items-center gap-3">
            <Phone className="w-5 h-5 text-green-400 animate-pulse flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Llamando...</p>
              <p className="text-xs text-muted-foreground font-mono">Esperando respuesta</p>
            </div>
            <button
              onClick={() => webrtc.endCall()}
              className="p-1.5 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Remains mounted independently of the visual call overlay. */}
      <RemoteAudioStreams tracks={webrtc.remoteAudioTracks} preferences={callSourcePreferences} />
      {isCallActive && showCallSources && (
        <div className="fixed bottom-20 right-4 z-[70] max-h-[min(70dvh,620px)] w-[min(360px,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl">
          <CallSourceControls
            participants={sourceParticipants}
            onAudioChange={changeSourceLevel}
            onToggleVideo={toggleSourceVideo}
            onClose={() => setShowCallSources(false)}
          />
        </div>
      )}
      {/* ── In-call overlay (voice/video) ────────────────────────────────── */}
      {!isCallMinimized && (webrtc.callState === 'connected' || webrtc.isInVoiceChannel) && (
        <div className="fixed inset-0 z-40 bg-black/95 flex flex-col">
          {watch.session && !watch.isWatching && !isWatchOpen && (
            <div
              className="fixed left-1/2 top-4 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-primary/30 bg-card px-4 py-3 text-sm shadow-xl"
              role="status"
              data-testid="watch-invitation"
            >
              <div className="min-w-0">
                <p className="font-medium text-foreground">Invitación a visionado conjunto</p>
                <p className="truncate text-xs text-muted-foreground">Puedes unirte cuando quieras; la llamada continúa.</p>
              </div>
              <button
                type="button"
                className="flex-shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                onClick={() => setIsWatchOpen(true)}
              >
                Ver invitación
              </button>
            </div>
          )}
          {/* Shared content takes priority; each remote screen has its own video stream. */}
          <div className="flex-1 min-h-0 p-4 flex flex-col gap-3">
            <CallScreenGallery screens={sharedScreens} featuredKey={featuredScreenKey} onFeature={setFeaturedScreenKey} />

            {/* Remote streams grid */}
            <div className={`grid min-h-0 flex-1 gap-3 ${webrtc.remoteStreams.size === 0 ? 'grid-cols-1' : webrtc.remoteStreams.size <= 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {/* Local self-view (small) */}
              <div className={`rounded-2xl overflow-hidden bg-secondary border relative ${webrtc.activeSpeakerId === user.id ? 'border-green-400 shadow-[0_0_12px_rgba(74,222,128,0.4)]' : 'border-white/10'}`}>
                {webrtc.isCameraOn && webrtc.localStream?.getVideoTracks().some(track => track.readyState === 'live') ? (
                  <video
                    autoPlay
                    muted
                    playsInline
                    className="w-full h-full object-cover"
                    ref={el => { if (el) el.srcObject = webrtc.localStream; }}
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="w-16 h-16 rounded-full bg-secondary overflow-hidden">
                      {user.avatarUrl ? <AvatarImage url={user.avatarUrl} /> : <UsersIcon className="w-8 h-8 m-4 text-muted-foreground" />}
                    </div>
                  </div>
                )}
                <div className="absolute bottom-2 left-3 text-xs text-white/80 font-mono bg-black/60 px-2 py-0.5 rounded-md flex items-center gap-1">
                  {webrtc.isMuted && <MicOff className="w-3 h-3 text-red-400" />}
                  {user.displayName} (vos)
                </div>
              </div>

              {/* Remote peers */}
              {Array.from(webrtc.remoteStreams.entries()).map(([peerId, stream]) => {
                const peerMember = webrtc.voiceMembers.find(m => m.userId === peerId);
                const isActive = webrtc.activeSpeakerId === peerId;
                return (
                  <div key={peerId} className={`rounded-2xl overflow-hidden bg-secondary border relative ${isActive ? 'border-green-400 shadow-[0_0_12px_rgba(74,222,128,0.4)]' : 'border-white/10'}`}>
                    <div
                      className={sourcePreferencesFor(callSourcePreferences, peerId).cameraVisible ? 'h-full w-full' : 'hidden'}
                      aria-hidden={!sourcePreferencesFor(callSourcePreferences, peerId).cameraVisible}
                    >
                      <RemoteVideo stream={stream} />
                    </div>
                    {!sourcePreferencesFor(callSourcePreferences, peerId).cameraVisible && (
                      <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                        Cámara oculta para ti
                      </div>
                    )}
                    <div className="absolute bottom-2 left-3 text-xs text-white/80 font-mono bg-black/60 px-2 py-0.5 rounded-md">
                      {peerMember?.displayName ?? `Usuario ${peerId}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Control bar */}
          <CallExpandedControls
            isSourcesOpen={showCallSources}
            onToggleSources={() => setShowCallSources(open => !open)}
            isMuted={webrtc.isMuted}
            onToggleMute={webrtc.toggleMute}
            isCameraOn={webrtc.isCameraOn}
            onToggleCamera={webrtc.toggleCamera}
            isScreenShareStarting={webrtc.isScreenShareStarting}
            isScreenSharing={webrtc.isScreenSharing}
            onToggleScreenShare={webrtc.toggleScreenShare}
            screenShareNotice={webrtc.screenShareNotice}
            isSoundboardOpen={isSoundboardOpen}
            onToggleSoundboard={() => setIsSoundboardOpen(open => !open)}
            isWatching={isWatchVisible}
            hasWatchInvitation={!!watch.session && !watch.isWatching}
            onToggleWatch={() => {
              setIsSoundboardOpen(false);
              setIsWatchOpen(open => !open);
            }}
            onHangUp={() => webrtc.isInVoiceChannel ? webrtc.leaveVoiceChannel() : webrtc.endCall()}
            onMinimize={() => setIsCallMinimized(true)}
          />
        </div>
      )}

      {isWatchVisible && currentCallKey && (
        <aside
          aria-label="Visionado y escucha sincronizados"
          className={`fixed right-0 top-0 bottom-[45dvh] z-[55] w-full min-w-[200px] border-l border-border bg-background shadow-2xl md:right-4 md:top-4 md:w-[min(520px,40vw)] ${isCallMinimized ? 'md:bottom-4' : 'md:bottom-24'}`}
        >
          <WatchPanel
            session={watch.session}
            isWatching={watch.isWatching}
            localVolume={localWatchVolume}
            onLocalVolumeChange={setLocalWatchVolume}
            canControl={watch.canControl}
            onStart={url => { watch.start(url); }}
            onAdd={url => { watch.add(url); }}
            onJoin={() => { watch.join(); }}
            onLeave={() => { watch.leave(); }}
            onAction={(action, values) => { watch.control(action, values); }}
            error={watch.error}
            active={webrtc.isInVoiceChannel ? 'voice' : 'dm'}
            participants={watchParticipants}
            currentUserId={user?.id}
            onClose={() => setIsWatchOpen(false)}
            player={watch.session?.current ? (
              <WatchPlayer
                current={watch.session.current}
                playing={watch.session.playing}
                positionMs={watch.session.positionMs}
                updatedAtMs={watch.session.updatedAtMs}
                durationMs={watch.session.current.durationMs}
                localVolume={localWatchVolume}
                canControl={watch.canControl}
                sessionKey={currentCallKey}
                onVolumeChange={setLocalWatchVolume}
                onPlay={() => { watch.control('play'); }}
                onPause={() => { watch.control('pause'); }}
                onSeek={positionMs => { watch.control('seek', { positionMs }); }}
                onEnded={itemId => { watch.control('ended', { itemId }); }}
                onMetadata={({ title, durationMs }) => {
                  const current = watch.session?.current;
                  if (!watch.isController || !current) return;
                  if (current.title === title && (!durationMs || durationMs === current.durationMs)) return;
                  watch.control('metadata', { itemId: current.id, title, ...(durationMs ? { durationMs } : {}) });
                }}
                onLoadError={watch.reportLoadError}
              />
            ) : null}
          />
        </aside>
      )}

      {isCallActive && (
        <div className={`fixed bottom-24 z-50 ${isWatchVisible ? 'left-4' : 'right-4'}`}>
          <SoundboardPanel
            isOpen={isSoundboardOpen}
            onClose={() => setIsSoundboardOpen(false)}
            callType={webrtc.isInVoiceChannel ? 'voice' : 'dm'}
            serverId={webrtc.isInVoiceChannel && webrtc.activeVoiceChannelId
              ? channelMetadata.get(webrtc.activeVoiceChannelId)?.serverId
                ?? channels?.find(c => c.id === webrtc.activeVoiceChannelId)?.serverId
              : null}
            peerId={webrtc.isInVoiceChannel ? null : webrtc.dmCallUserId}
            onTrigger={triggerSoundboardClip}
            onClipsLoaded={soundboardPlayback.preloadClips}
          />
        </div>
      )}

      {/* Modals */}
      <ProfileModal user={user} isOpen={isProfileOpen} onClose={() => setIsProfileOpen(false)} />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={audioVideoSettings}
        onSettingsChange={next => {
          if (user?.id) setAudioVideoProfile({ userId: user.id, settings: next });
        }}
        currentUserId={user?.id}
        notificationSettings={notificationSettings}
        onNotificationSettingsChange={updateNotificationSettings}
        soundboardSettings={soundboardSettings}
        onSoundboardSettingsChange={updateSoundboardSettings}
        serverOptions={(servers ?? []).map(server => ({ id: server.id, name: server.name }))}
        activeServerId={activeServerId}
      />
      {isServerSettingsOpen && activeServer && (
        <ServerSettingsModal
          isOpen={isServerSettingsOpen}
          serverId={activeServer.id}
          serverName={activeServer.name}
          serverIconUrl={(activeServer as any).iconUrl}
          serverBannerUrl={(activeServer as any).bannerUrl}
          isGeneral={(activeServer as any).isGeneral ?? false}
          isOwner={currentMembership?.role === 'owner'}
          members={members ?? []}
          currentUserId={user.id}
          currentUserMembershipRole={currentMembership?.role ?? 'member'}
          onClose={() => setIsServerSettingsOpen(false)}
          onDeleted={() => {
            setIsServerSettingsOpen(false);
            setActiveServerId(null as any);
            setActiveChannelId(null as any);
          }}
        />
      )}
      {selectedUserId && selectedAnchorRect && (
        <UserProfileCard
          userId={selectedUserId}
          currentUserId={user.id}
          anchorRect={selectedAnchorRect}
          onClose={() => { setSelectedUserId(null); setSelectedAnchorRect(null); }}
          onOpenDm={openDm}
        />
      )}
      <CreateServerModal
        isOpen={isCreateServerOpen}
        onClose={() => setIsCreateServerOpen(false)}
        onCreated={(server: any) => {
          queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
          setActiveServerId(server.id);
          setIsCreateServerOpen(false);
        }}
      />
      {activeServerId && (
        <CreateChannelModal
          isOpen={isCreateChannelOpen}
          serverId={activeServerId}
          onClose={() => setIsCreateChannelOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey(activeServerId) });
            setIsCreateChannelOpen(false);
          }}
        />
      )}

      {/* DM Group modal */}
      {showDmGroupModal && (
        <DmGroupModal
          isOpen={showDmGroupModal}
          onClose={() => setShowDmGroupModal(false)}
          currentUserId={user.id}
          friends={dmFriends}
          onCreated={group => {
            setShowDmGroupModal(false);
            queryClient.invalidateQueries({ queryKey: ['/api/dm-groups'] });
            setActiveView('dms');
            setDmSubView('messages');
            setActiveDmUserId(null);
            setActiveDmGroupId(group.id);
          }}
        />
      )}

      {/* Search modal */}
      {showSearch && (
        <SearchModal
          isOpen={showSearch}
          onClose={() => setShowSearch(false)}
          serverId={activeView === 'servers' ? activeServerId : null}
          channelId={activeChannelId}
          dmUserId={activeView === 'dms' ? activeDmUserId : null}
          onJumpToMessage={(cid, mid) => {
            setShowSearch(false);
            const el = messageRefs.current.get(mid);
            if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('ring', 'ring-primary/40'); setTimeout(() => el.classList.remove('ring', 'ring-primary/40'), 2000); }
          }}
        />
      )}

      {/* Report modal */}
      {reportTarget && (
        <ReportModal
          messageId={reportTarget.messageId}
          serverId={activeServerId}
          authorName={reportTarget.authorName}
          onClose={() => setReportTarget(null)}
        />
      )}
    </div>
  );
}
