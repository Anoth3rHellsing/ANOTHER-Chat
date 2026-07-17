import { useState, useRef, useEffect, useMemo } from 'react';
import { useLocation } from 'wouter';
import { 
  useGetCurrentUser, useListServers, useCreateServer, useJoinServer,
  useGetServerMembers, useListChannels, useCreateChannel, 
  useListMessages, useSendMessage, useEditMessage, useDeleteMessage,
  useUpdateMyProfile, getGetCurrentUserQueryKey,
  getListChannelsQueryKey, getListServersQueryKey, getGetServerMembersQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useChatWebSocket } from '@/hooks/use-chat-websocket';
import { ProfileModal } from '@/components/profile-modal';
import { ServerSettingsModal } from '@/components/server-settings-modal';
import { getEffectivePermissions, hasPerm, PERM } from '@/lib/permissions';
import { useToast } from '@/hooks/use-toast';
import { 
  Hash, Settings, LogOut, Plus, Shield, ShieldAlert,
  Send, MoreVertical, Edit2, Trash2, Users as UsersIcon, X, SlidersHorizontal
} from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

export default function AppLayout() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: user, isLoading: userLoading } = useGetCurrentUser();
  const { data: servers, isLoading: serversLoading } = useListServers();

  const [activeServerId, setActiveServerId] = useState<number | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<number | null>(null);
  
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isServerSettingsOpen, setIsServerSettingsOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(true);

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
      if (!validChannel) {
        setActiveChannelId(channels[0].id);
      }
    } else {
      if (!channels || channels.length === 0) {
        setActiveChannelId(null);
      }
    }
  }, [channels, activeServerId, activeChannelId]);

  const { data: members } = useGetServerMembers(activeServerId as number, { query: { enabled: !!activeServerId } as any });
  const { data: messages } = useListMessages(activeChannelId as number, {}, { query: { enabled: !!activeChannelId } as any });
  
  const { typingUsers, sendTypingStart, sendTypingStop } = useChatWebSocket(activeChannelId);

  const sendMessage = useSendMessage();
  const editMessage = useEditMessage();
  const deleteMessage = useDeleteMessage();
  const createServer = useCreateServer();
  const createChannel = useCreateChannel();

  const [messageInput, setMessageInput] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editInput, setEditInput] = useState('');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [messages]);

  const handleMessageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setMessageInput(e.target.value);
    sendTypingStart();
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => sendTypingStop(), 2000);
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageInput.trim() || !activeChannelId) return;
    const channelId = activeChannelId;

    sendMessage.mutate(
      { channelId, data: { content: messageInput.trim() } },
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
          setMessageInput('');
          sendTypingStop();
        }
      }
    );
  };

  const handleEditMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editInput.trim() || !editingMessageId || !activeChannelId) return;

    editMessage.mutate(
      { channelId: activeChannelId, messageId: editingMessageId, data: { content: editInput.trim() } },
      { onSuccess: () => { setEditingMessageId(null); setEditInput(''); } }
    );
  };

  const handleCreateServer = () => {
    const name = prompt("Nombre del nuevo servidor clasificado:");
    if (name) {
      createServer.mutate({ data: { name } }, {
        onSuccess: (newServer) => {
          queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
          setActiveServerId(newServer.id);
          toast({ title: "Servidor creado" });
        }
      });
    }
  };

  const handleCreateChannel = () => {
    const name = prompt("Nombre del canal (sin espacios, minúsculas):");
    if (name && activeServerId) {
      createChannel.mutate({ serverId: activeServerId, data: { name: name.toLowerCase().replace(/\s+/g, '-') } }, {
        onSuccess: (newChannel) => {
          queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey(activeServerId) });
          setActiveChannelId(newChannel.id);
          toast({ title: "Canal creado" });
        }
      });
    }
  };

  // Redirect to login when auth check completes and there's no user.
  useEffect(() => {
    if (!userLoading && !user) {
      setLocation('/');
    }
  }, [userLoading, user, setLocation]);

  const activeServer = servers?.find(s => s.id === activeServerId);
  const activeChannel = channels?.find(c => c.id === activeChannelId);

  // Current user's membership in the active server
  const currentMembership = useMemo(() => {
    if (!members || !user) return null;
    return members.find(m => m.userId === user.id) ?? null;
  }, [members, user]);

  // Effective permissions (bitmask) for the current user
  const myPermissions = useMemo(() => {
    if (!currentMembership) return 0;
    return getEffectivePermissions(currentMembership.role, currentMembership.roles ?? []);
  }, [currentMembership]);

  const canManageServer = user?.role === 'admin' ||
    currentMembership?.role === 'owner' ||
    currentMembership?.role === 'admin';

  const canCreateChannel = canManageServer || hasPerm(myPermissions, PERM.MANAGE_CHANNELS);

  // Group members — declared before any early returns to satisfy hooks rules.
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

  // Guard: show spinner while auth loads; redirect effect handles the !user case
  if (userLoading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center text-primary">
        <Shield className="w-8 h-8 animate-pulse" />
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="h-screen w-full bg-background flex overflow-hidden font-sans">
      
      {/* 1. SERVER LIST COLUMN */}
      <div className="w-[72px] bg-card border-r border-white/5 flex flex-col items-center py-4 gap-3 flex-shrink-0 z-20">
        <div className="w-12 h-12 rounded-2xl bg-primary/20 flex items-center justify-center text-primary cursor-pointer hover:rounded-xl transition-all" onClick={() => setLocation('/app')}>
          <Shield className="w-7 h-7" />
        </div>
        
        <div className="w-8 h-[2px] bg-white/10 rounded-full" />

        <div className="flex-1 w-full overflow-y-auto hide-scrollbar flex flex-col items-center gap-3">
          {servers?.map(server => (
            <div key={server.id} className="relative group flex justify-center w-full">
              <div className={`absolute left-0 w-1 bg-primary rounded-r-full transition-all duration-200 ${activeServerId === server.id ? 'h-10 top-1' : 'h-2 top-5 opacity-0 group-hover:opacity-100 group-hover:h-5'}`} />
              <button
                onClick={() => setActiveServerId(server.id)}
                className={`w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all overflow-hidden bg-secondary flex items-center justify-center border border-white/5 ${activeServerId === server.id ? 'rounded-[16px] bg-primary/20 text-primary border-primary/50' : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'}`}
                title={server.name}
              >
                {server.iconUrl ? <img src={server.iconUrl} className="w-full h-full object-cover" alt="" /> : <span className="font-mono font-bold">{server.name.substring(0, 2).toUpperCase()}</span>}
              </button>
            </div>
          ))}
          
          <button onClick={handleCreateServer} className="w-12 h-12 rounded-[24px] hover:rounded-[16px] transition-all bg-secondary border border-white/10 text-green-500 hover:bg-green-500/20 flex items-center justify-center group" title="Añadir Servidor">
            <Plus className="w-6 h-6 group-hover:scale-110 transition-transform" />
          </button>
        </div>
      </div>

      {/* 2. CHANNEL LIST COLUMN */}
      <div className="w-60 bg-card/50 border-r border-white/5 flex flex-col flex-shrink-0">
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
        
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="flex items-center justify-between px-2 mb-1 group">
            <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Canales</p>
            {activeServer && canCreateChannel && (
              <button onClick={handleCreateChannel} className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                <Plus className="w-4 h-4" />
              </button>
            )}
          </div>
          
          {channels?.map(channel => (
            <button
              key={channel.id}
              onClick={() => setActiveChannelId(channel.id)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${activeChannelId === channel.id ? 'bg-white/10 text-foreground font-medium' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}
            >
              <Hash className="w-4 h-4 opacity-50 flex-shrink-0" />
              <span className="truncate">{channel.name}</span>
              {/* Lock indicator for restricted channels */}
              {(channel as any).restrictedRoles?.length > 0 && (
                <span className="ml-auto text-[10px] text-primary/60 font-mono flex-shrink-0">🔒</span>
              )}
            </button>
          ))}
        </div>

        {/* User Info Area */}
        <div className="h-16 bg-card border-t border-white/5 flex items-center px-3 gap-2">
          <button onClick={() => setIsProfileOpen(true)} className="relative group">
            <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden">
              {user.avatarUrl ? <img src={user.avatarUrl} className="w-full h-full object-cover" alt="" /> : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
            </div>
            <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-card ${getStatusColor(user.status)}`} />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate leading-tight">{user.displayName}</p>
            <p className="text-xs text-muted-foreground font-mono truncate leading-tight">@{user.username}</p>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setIsProfileOpen(true)} className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10 transition-colors">
              <Settings className="w-4 h-4" />
            </button>
            {user.role === 'admin' && (
              <button onClick={() => setLocation('/app/admin')} className="p-1.5 text-primary hover:text-primary rounded-md hover:bg-primary/20 transition-colors" title="Panel de Admin">
                <ShieldAlert className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 3. CHAT AREA */}
      <div className="flex-1 flex flex-col bg-background min-w-0 relative">
        {activeChannel ? (
          <>
            <div className="h-12 border-b border-white/5 flex items-center px-4 justify-between bg-card/30 backdrop-blur-sm z-10">
              <div className="flex items-center gap-2 text-foreground font-medium">
                <Hash className="w-5 h-5 text-muted-foreground" />
                {activeChannel.name}
                {(activeChannel as any).restrictedRoles?.length > 0 && (
                  <span className="text-xs text-primary/60 font-mono">🔒 restringido</span>
                )}
              </div>
              <button 
                onClick={() => setShowMembers(!showMembers)}
                className={`p-1.5 rounded-md transition-colors ${showMembers ? 'bg-white/10 text-white' : 'text-muted-foreground hover:bg-white/5 hover:text-white'}`}
              >
                <UsersIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {messages?.map((msg, idx) => {
                const isFirst = idx === 0 || messages[idx - 1].userId !== msg.userId || new Date(msg.createdAt).getTime() - new Date(messages[idx - 1].createdAt).getTime() > 300000;
                const isOwn = msg.userId === user.id;

                return (
                  <div key={msg.id} className={`group flex gap-4 ${isFirst ? 'mt-6' : 'mt-1'}`}>
                    {isFirst ? (
                      <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden flex-shrink-0 cursor-pointer">
                        {msg.author.avatarUrl ? <img src={msg.author.avatarUrl} className="w-full h-full object-cover" alt="" /> : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
                      </div>
                    ) : (
                      <div className="w-10 flex-shrink-0 opacity-0 group-hover:opacity-100 text-[10px] text-muted-foreground font-mono text-center self-center">
                        {format(new Date(msg.createdAt), 'HH:mm')}
                      </div>
                    )}
                    
                    <div className="flex-1 min-w-0">
                      {isFirst && (
                        <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                          <span className="font-medium text-foreground hover:underline cursor-pointer">{msg.author.displayName}</span>
                          <span className="text-xs text-muted-foreground font-mono">{format(new Date(msg.createdAt), "dd/MM/yyyy HH:mm")}</span>
                        </div>
                      )}
                      
                      <div className="flex items-start justify-between gap-4">
                        {editingMessageId === msg.id ? (
                          <form onSubmit={handleEditMessage} className="w-full relative">
                            <input 
                              type="text"
                              value={editInput}
                              onChange={e => setEditInput(e.target.value)}
                              className="w-full bg-secondary border border-white/10 rounded px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                              autoFocus
                            />
                            <div className="text-xs text-muted-foreground mt-1">Esc para cancelar, Enter para guardar</div>
                          </form>
                        ) : (
                          <div className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
                            {msg.deletedAt ? (
                              <span className="text-muted-foreground italic font-mono">[mensaje eliminado]</span>
                            ) : (
                              <>
                                {msg.content}
                                {msg.editedAt && <span className="text-[10px] text-muted-foreground ml-2 font-mono">(editado)</span>}
                              </>
                            )}
                          </div>
                        )}

                        {!msg.deletedAt && editingMessageId !== msg.id && (
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center bg-card border border-white/5 rounded-md overflow-hidden flex-shrink-0">
                            {isOwn && (
                              <button onClick={() => { setEditingMessageId(msg.id); setEditInput(msg.content); }} className="p-1.5 text-muted-foreground hover:bg-white/10 hover:text-white transition-colors" title="Editar">
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {(isOwn || hasPerm(myPermissions, PERM.MANAGE_MESSAGES) || canManageServer) && (
                              <>
                                {isOwn && <div className="w-[1px] h-4 bg-white/10" />}
                                <button onClick={() => activeChannelId && deleteMessage.mutate({ channelId: activeChannelId, messageId: msg.id })} className="p-1.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors" title="Eliminar">
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 pt-0">
              <div className="h-6 flex items-end px-2">
                {typingUsers.size > 0 && (
                  <span className="text-xs text-primary font-mono animate-pulse">
                    {typingUsers.size === 1 ? 'Alguien está escribiendo...' : 'Varios operarios están escribiendo...'}
                  </span>
                )}
              </div>
              <form onSubmit={handleSendMessage} className="relative flex items-center">
                <input 
                  type="text"
                  value={messageInput}
                  onChange={handleMessageChange}
                  placeholder={`Escribir en #${activeChannel.name}...`}
                  className="w-full bg-card border border-white/10 rounded-xl pl-4 pr-12 py-3.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-all font-sans"
                />
                <button 
                  type="submit" 
                  disabled={!messageInput.trim() || sendMessage.isPending}
                  className="absolute right-2 p-2 text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
                >
                  <Send className="w-5 h-5" />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <Hash className="w-16 h-16 opacity-20 mb-4" />
            <p>Selecciona o crea un canal para comenzar.</p>
          </div>
        )}
      </div>

      {/* 4. MEMBER LIST COLUMN */}
      {showMembers && activeChannel && (
        <div className="w-60 bg-card/30 border-l border-white/5 flex flex-col flex-shrink-0">
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            
            {groupedMembers.online.length > 0 && (
              <div>
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Conectados — {groupedMembers.online.length}</h3>
                <div className="space-y-1">
                  {groupedMembers.online.map(member => (
                    <div key={member.id} className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-white/5 cursor-pointer group">
                      <div className="relative flex-shrink-0">
                        <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden">
                          {member.user.avatarUrl ? <img src={member.user.avatarUrl} className="w-full h-full object-cover" alt="" /> : <UsersIcon className="w-4 h-4 m-2 text-muted-foreground" />}
                        </div>
                        <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-background ${getStatusColor(member.user.status)}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${member.role === 'admin' || member.role === 'owner' ? 'text-primary' : 'text-foreground/90'}`}>
                          {member.user.displayName}
                        </p>
                        {/* Role badges */}
                        {member.roles && member.roles.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {member.roles.slice(0, 2).map((role: any) => (
                              <span
                                key={role.id}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded-full text-[10px] font-medium leading-4"
                                style={{ backgroundColor: role.color + '22', color: role.color, border: `1px solid ${role.color}44` }}
                              >
                                {role.name}
                              </span>
                            ))}
                            {member.roles.length > 2 && (
                              <span className="text-[10px] text-muted-foreground">+{member.roles.length - 2}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {groupedMembers.offline.length > 0 && (
              <div>
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Desconectados — {groupedMembers.offline.length}</h3>
                <div className="space-y-1">
                  {groupedMembers.offline.map(member => (
                    <div key={member.id} className="flex items-center gap-3 px-2 py-1.5 rounded-md opacity-50 hover:opacity-100 hover:bg-white/5 cursor-pointer transition-opacity">
                      <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                        {member.user.avatarUrl ? <img src={member.user.avatarUrl} className="w-full h-full object-cover grayscale" alt="" /> : <UsersIcon className="w-4 h-4 m-2 text-muted-foreground" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate text-foreground">{member.user.displayName}</p>
                        {member.roles && member.roles.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {member.roles.slice(0, 1).map((role: any) => (
                              <span
                                key={role.id}
                                className="inline-flex items-center px-1.5 py-0 rounded-full text-[10px] font-medium leading-4"
                                style={{ backgroundColor: role.color + '22', color: role.color, border: `1px solid ${role.color}44` }}
                              >
                                {role.name}
                              </span>
                            ))}
                            {member.roles.length > 1 && (
                              <span className="text-[10px] text-muted-foreground">+{member.roles.length - 1}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* Profile Modal */}
      {user && (
        <ProfileModal 
          isOpen={isProfileOpen} 
          onClose={() => setIsProfileOpen(false)} 
          user={user} 
        />
      )}

      {/* Server Settings Modal */}
      {activeServer && activeServerId && (
        <ServerSettingsModal
          isOpen={isServerSettingsOpen}
          onClose={() => setIsServerSettingsOpen(false)}
          serverId={activeServerId}
          serverName={activeServer.name}
          members={members ?? []}
          currentUserId={user.id}
          currentUserMembershipRole={currentMembership?.role ?? 'member'}
        />
      )}
    </div>
  );
}
