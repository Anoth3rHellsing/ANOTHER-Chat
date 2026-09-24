import { useEffect, useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { csrfFetch } from '@workspace/api-client-react';
import {
  useListServerRoles,
  useCreateServerRole,
  useUpdateServerRole,
  useDeleteServerRole,
  useAssignMemberRole,
  useRemoveMemberRole,
  useUpdateChannel,
  useListChannels,
  useListServerInvites,
  useCreateServerInvite,
  useRevokeServerInvite,
  getListServerRolesQueryKey,
  getGetServerMembersQueryKey,
  getListChannelsQueryKey,
  getListServerInvitesQueryKey,
  getListServersQueryKey,
} from '@workspace/api-client-react';
import { X, Plus, Trash2, Check, Shield, Hash, Lock, Copy, Link2, Image as ImageIcon, RefreshCw, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { PERM, PERM_LABELS, hasPerm } from '@/lib/permissions';
import { sameOriginUploadUrl } from '@/lib/media-url';

interface ServerSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: number;
  serverName: string;
  serverIconUrl?: string | null;
  serverBannerUrl?: string | null;
  isGeneral?: boolean;
  isOwner?: boolean;
  members: any[];
  currentUserId: number;
  currentUserMembershipRole: string;
  onDeleted?: () => void;
}

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#06b6d4', '#a855f7', '#64748b',
];

type Tab = 'roles' | 'channels' | 'members' | 'apariencia' | 'invitaciones' | 'mutes' | 'word_filters' | 'reports' | 'audit' | 'peligro';

export function ServerSettingsModal({
  isOpen,
  onClose,
  serverId,
  serverName,
  serverIconUrl,
  serverBannerUrl,
  isGeneral,
  isOwner,
  members,
  currentUserId,
  currentUserMembershipRole,
  onDeleted,
}: ServerSettingsModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('roles');
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Moderation state
  const [mutes, setMutes] = useState<any[]>([]);
  const [wordFilters, setWordFilters] = useState<any[]>([]);
  const [reports, setReports] = useState<any[]>([]);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [newWord, setNewWord] = useState('');
  const [muteTargetUsername, setMuteTargetUsername] = useState('');
  const [muteDuration, setMuteDuration] = useState('60');
  const [muteReason, setMuteReason] = useState('');
  const [mutingUser, setMutingUser] = useState(false);

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

  useEffect(() => {
    if (!isOpen || !serverId) return;
    if (activeTab === 'mutes') {
      csrfFetch(`${BASE}/api/servers/${serverId}/mutes`, { credentials: 'include' })
        .then(r => r.json()).then(d => setMutes(Array.isArray(d) ? d : [])).catch(() => {});
    }
    if (activeTab === 'word_filters') {
      csrfFetch(`${BASE}/api/servers/${serverId}/word-filters`, { credentials: 'include' })
        .then(r => r.json()).then(d => setWordFilters(Array.isArray(d) ? d : [])).catch(() => {});
    }
    if (activeTab === 'reports') {
      csrfFetch(`${BASE}/api/servers/${serverId}/reports`, { credentials: 'include' })
        .then(r => r.json()).then(d => setReports(Array.isArray(d) ? d : [])).catch(() => {});
    }
    if (activeTab === 'audit') {
      csrfFetch(`${BASE}/api/servers/${serverId}/audit-log`, { credentials: 'include' })
        .then(r => r.json()).then(d => setAuditLog(Array.isArray(d) ? d : [])).catch(() => {});
    }
  }, [activeTab, isOpen, serverId]);

  const handleMuteUser = async () => {
    if (!muteTargetUsername.trim()) return;
    setMutingUser(true);
    try {
      const userRes = await csrfFetch(`${BASE}/api/users/by-username/${encodeURIComponent(muteTargetUsername.trim())}`, { credentials: 'include' });
      // Fallback: search by username through members list
      const member = members.find(m => m.user.username.toLowerCase() === muteTargetUsername.trim().toLowerCase());
      if (!member) { toast({ title: 'Usuario no encontrado en el servidor', variant: 'destructive' }); setMutingUser(false); return; }
      const res = await csrfFetch(`${BASE}/api/servers/${serverId}/mutes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: member.userId, durationMinutes: parseInt(muteDuration, 10), reason: muteReason || null }),
      });
      if (res.ok) {
        toast({ title: `${member.user.displayName} silenciado por ${muteDuration} minutos` });
        setMuteTargetUsername(''); setMuteReason('');
        csrfFetch(`${BASE}/api/servers/${serverId}/mutes`, { credentials: 'include' })
          .then(r => r.json()).then(d => setMutes(Array.isArray(d) ? d : [])).catch(() => {});
      } else {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error ?? 'Error', variant: 'destructive' });
      }
    } catch { toast({ title: 'Error de red', variant: 'destructive' }); }
    setMutingUser(false);
  };

  const handleUnmute = async (muteId: number) => {
    await csrfFetch(`${BASE}/api/servers/${serverId}/mutes/${muteId}`, { method: 'DELETE', credentials: 'include' });
    setMutes(prev => prev.filter(m => m.id !== muteId));
    toast({ title: 'Silencio eliminado' });
  };

  const handleAddWord = async () => {
    if (!newWord.trim()) return;
    const res = await csrfFetch(`${BASE}/api/servers/${serverId}/word-filters`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ word: newWord.trim() }),
    });
    if (res.ok) {
      const w = await res.json();
      if (!w.duplicate) setWordFilters(prev => [...prev, w]);
      setNewWord('');
      toast({ title: `"${newWord.trim()}" añadido al filtro` });
    }
  };

  const handleRemoveWord = async (filterId: number) => {
    await csrfFetch(`${BASE}/api/servers/${serverId}/word-filters/${filterId}`, { method: 'DELETE', credentials: 'include' });
    setWordFilters(prev => prev.filter(f => f.id !== filterId));
  };

  const handleResolveReport = async (reportId: number, action: 'dismiss' | 'delete_message') => {
    await csrfFetch(`${BASE}/api/reports/${reportId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ action }),
    });
    setReports(prev => prev.filter(r => r.id !== reportId));
    toast({ title: action === 'dismiss' ? 'Reporte descartado' : 'Mensaje eliminado' });
  };

  const { data: roles = [] } = useListServerRoles(serverId, { query: { enabled: isOpen && !!serverId } as any });
  const { data: channels = [] } = useListChannels(serverId, { query: { enabled: isOpen && !!serverId } as any });
  const { data: invites = [], isLoading: invitesLoading } = useListServerInvites(serverId, { query: { enabled: isOpen && !!serverId && activeTab === 'invitaciones' } as any });

  const updateChannel = useUpdateChannel();
  const createRole = useCreateServerRole();
  const updateRole = useUpdateServerRole();
  const deleteRole = useDeleteServerRole();
  const assignRole = useAssignMemberRole();
  const removeRole = useRemoveMemberRole();
  const createInvite = useCreateServerInvite();
  const revokeInvite = useRevokeServerInvite();
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);

  const iconInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  // Role editor state
  const [editingRoleId, setEditingRoleId] = useState<number | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleColor, setRoleColor] = useState('#6366f1');
  const [rolePermissions, setRolePermissions] = useState(0);
  const [isCreating, setIsCreating] = useState(false);

  const invalidateRoles = () => {
    queryClient.invalidateQueries({ queryKey: getListServerRolesQueryKey(serverId) });
    queryClient.invalidateQueries({ queryKey: getGetServerMembersQueryKey(serverId) });
  };

  const handleToggleChannelRole = (channel: any, roleId: number) => {
    const current: number[] = channel.restrictedRoles ?? [];
    const next = current.includes(roleId)
      ? current.filter((id: number) => id !== roleId)
      : [...current, roleId];
    updateChannel.mutate(
      { channelId: channel.id, data: { restrictedRoles: next } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey(serverId) }) }
    );
  };

  const startCreate = () => {
    setIsCreating(true);
    setEditingRoleId(null);
    setRoleName('');
    setRoleColor('#6366f1');
    setRolePermissions(0);
  };

  const startEdit = (role: any) => {
    setIsCreating(false);
    setEditingRoleId(role.id);
    setRoleName(role.name);
    setRoleColor(role.color);
    setRolePermissions(role.permissions);
  };

  const cancelEdit = () => {
    setIsCreating(false);
    setEditingRoleId(null);
  };

  const togglePerm = (flag: number) => {
    setRolePermissions((p) => hasPerm(p, flag) ? p & ~flag : p | flag);
  };

  const handleSaveRole = () => {
    if (!roleName.trim()) return;
    if (isCreating) {
      createRole.mutate(
        { serverId, data: { name: roleName.trim(), color: roleColor, permissions: rolePermissions } },
        {
          onSuccess: () => {
            invalidateRoles();
            setIsCreating(false);
            toast({ title: 'Rol creado' });
          },
        }
      );
    } else if (editingRoleId) {
      updateRole.mutate(
        { serverId, roleId: editingRoleId, data: { name: roleName.trim(), color: roleColor, permissions: rolePermissions } },
        {
          onSuccess: () => {
            invalidateRoles();
            setEditingRoleId(null);
            toast({ title: 'Rol actualizado' });
          },
        }
      );
    }
  };

  const handleDeleteRole = (roleId: number) => {
    deleteRole.mutate(
      { serverId, roleId },
      {
        onSuccess: () => {
          invalidateRoles();
          if (editingRoleId === roleId) cancelEdit();
          toast({ title: 'Rol eliminado' });
        },
      }
    );
  };

  const handleToggleMemberRole = (member: any, role: any) => {
    const hasThisRole = member.roles?.some((r: any) => r.id === role.id);
    if (hasThisRole) {
      removeRole.mutate({ serverId, userId: member.userId, roleId: role.id }, { onSuccess: invalidateRoles });
    } else {
      assignRole.mutate({ serverId, userId: member.userId, roleId: role.id }, { onSuccess: invalidateRoles });
    }
  };

  const handleCreateInvite = () => {
    createInvite.mutate(
      { serverId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListServerInvitesQueryKey(serverId) });
          toast({ title: 'Invitación creada' });
        },
      }
    );
  };

  const handleRevokeInvite = (code: string) => {
    revokeInvite.mutate(
      { serverId, code },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListServerInvitesQueryKey(serverId) });
          toast({ title: 'Invitación revocada' });
        },
      }
    );
  };

  const copyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    toast({ title: 'Código copiado', description: code });
  };

  const handleUploadIcon = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingIcon(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await csrfFetch(`/api/servers/${serverId}/icon`, { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
      toast({ title: 'Icono actualizado' });
    } catch {
      toast({ title: 'Error al subir el icono', variant: 'destructive' });
    } finally {
      setUploadingIcon(false);
    }
  };

  const handleUploadBanner = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingBanner(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await csrfFetch(`/api/servers/${serverId}/banner`, { method: 'POST', body: form });
      if (!res.ok) throw new Error('Upload failed');
      queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
      toast({ title: 'Banner actualizado' });
    } catch {
      toast({ title: 'Error al subir el banner', variant: 'destructive' });
    } finally {
      setUploadingBanner(false);
    }
  };

  if (!isOpen) return null;

  const canManage = currentUserMembershipRole === 'owner' || currentUserMembershipRole === 'admin';

  const handleDeleteServer = async () => {
    if (deleteConfirmName !== serverName) return;
    setDeleting(true);
    try {
      const baseUrl = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
      const res = await csrfFetch(`${baseUrl}/api/servers/${serverId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (res.ok || res.status === 204) {
        queryClient.invalidateQueries({ queryKey: getListServersQueryKey() });
        toast({ title: 'Servidor eliminado' });
        onDeleted?.();
        onClose();
      } else {
        const data = await res.json().catch(() => ({}));
        toast({ title: data.error ?? 'Error al eliminar', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error de red', variant: 'destructive' });
    }
    setDeleting(false);
  };

  const TAB_LABELS: Record<Tab, string> = {
    roles: 'Roles',
    channels: 'Canales',
    members: 'Miembros',
    apariencia: 'Apariencia',
    invitaciones: 'Invitaciones',
    ...(canManage ? { mutes: '🔇 Silenciados', word_filters: '🚫 Filtros', reports: '⚑ Reportes', audit: '📋 Registro' } : {}),
    ...(isOwner && !isGeneral ? { peligro: '⚠ Peligro' } : {}),
  } as Record<Tab, string>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl max-h-[85vh] bg-card border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-primary" />
            <h2 className="font-bold text-foreground font-mono uppercase tracking-wider text-sm">
              Configuración — {serverName}
            </h2>
          </div>
          <button onClick={onClose} className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/10 flex-shrink-0 overflow-x-auto">
          {(Object.keys(TAB_LABELS) as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-3 text-sm font-mono uppercase tracking-wider transition-colors whitespace-nowrap flex-shrink-0 ${
                activeTab === tab
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">

          {/* ── ROLES TAB ─────────────────────────────── */}
          {activeTab === 'roles' && (
            <div className="space-y-4">
              <div className="space-y-2">
                {roles.map((role) => (
                  <div
                    key={role.id}
                    className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors cursor-pointer ${
                      editingRoleId === role.id
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-white/5 bg-white/5 hover:border-white/10'
                    }`}
                    onClick={() => editingRoleId === role.id ? cancelEdit() : startEdit(role)}
                  >
                    <div className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: role.color }} />
                    <span className="flex-1 text-sm font-medium text-foreground">{role.name}</span>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground font-mono">
                      {Object.entries(PERM).map(([key, flag]) =>
                        hasPerm(role.permissions, flag) ? (
                          <span key={key} className="px-1.5 py-0.5 rounded bg-primary/20 text-primary text-[10px]">
                            {key.replace('_', ' ').toLowerCase()}
                          </span>
                        ) : null
                      )}
                    </div>
                    {canManage && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteRole(role.id); }}
                        className="p-1 text-muted-foreground hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {roles.length === 0 && !isCreating && (
                  <p className="text-sm text-muted-foreground font-mono text-center py-4">No hay roles personalizados todavía.</p>
                )}
              </div>

              {(isCreating || editingRoleId !== null) && (
                <div className="border border-primary/30 rounded-lg p-4 bg-primary/5 space-y-4">
                  <h3 className="text-sm font-mono uppercase tracking-wider text-primary">
                    {isCreating ? 'Nuevo rol' : 'Editar rol'}
                  </h3>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Nombre</label>
                    <input
                      type="text"
                      value={roleName}
                      onChange={(e) => setRoleName(e.target.value)}
                      placeholder="p.ej. Operario"
                      className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                      autoFocus
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Color</label>
                    <div className="flex flex-wrap gap-2">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => setRoleColor(c)}
                          className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${roleColor === c ? 'border-white scale-110' : 'border-transparent'}`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Permisos</label>
                    <div className="space-y-2">
                      {Object.entries(PERM).map(([key, flag]) => (
                        <label key={key} className="flex items-center gap-3 cursor-pointer group">
                          <div
                            onClick={() => togglePerm(flag)}
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${hasPerm(rolePermissions, flag) ? 'border-primary bg-primary' : 'border-white/20 bg-transparent group-hover:border-white/40'}`}
                          >
                            {hasPerm(rolePermissions, flag) && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <span className="text-sm text-foreground">{PERM_LABELS[flag]}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={handleSaveRole}
                      disabled={!roleName.trim() || createRole.isPending || updateRole.isPending}
                      className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {isCreating ? 'Crear' : 'Guardar'}
                    </button>
                    <button onClick={cancelEdit} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              {canManage && !isCreating && editingRoleId === null && (
                <button
                  onClick={startCreate}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-dashed border-white/20 text-muted-foreground hover:border-primary/50 hover:text-primary transition-colors text-sm"
                >
                  <Plus className="w-4 h-4" />
                  Crear nuevo rol
                </button>
              )}
            </div>
          )}

          {/* ── CHANNELS TAB ──────────────────────────── */}
          {activeTab === 'channels' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-4">
                Controla qué roles pueden ver cada canal. Sin restricción = visible para todos.
              </p>
              {channels.length === 0 && (
                <p className="text-sm text-muted-foreground font-mono text-center py-4">No hay canales en este servidor.</p>
              )}
              {channels.map((channel: any) => {
                const restricted: number[] = channel.restrictedRoles ?? [];
                return (
                  <div key={channel.id} className="border border-white/5 rounded-lg p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Hash className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm font-medium text-foreground">{channel.name}</span>
                      {restricted.length > 0 && (
                        <span className="ml-auto flex items-center gap-1 text-xs text-primary/70 font-mono">
                          <Lock className="w-3 h-3" />restringido
                        </span>
                      )}
                    </div>
                    {roles.length === 0 ? (
                      <p className="text-xs text-muted-foreground font-mono pl-6">Crea roles para poder restringir canales.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2 pl-6">
                        {roles.map((role) => {
                          const isRestricted = restricted.includes(role.id);
                          return (
                            <button
                              key={role.id}
                              onClick={() => handleToggleChannelRole(channel, role.id)}
                              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${isRestricted ? '' : 'border-white/20 text-muted-foreground hover:border-white/40'}`}
                              style={isRestricted ? { backgroundColor: role.color + '33', borderColor: role.color, color: role.color } : {}}
                            >
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: role.color }} />
                              {role.name}
                              {isRestricted && <Check className="w-2.5 h-2.5" />}
                            </button>
                          );
                        })}
                        {restricted.length > 0 && (
                          <button
                            onClick={() => updateChannel.mutate(
                              { channelId: channel.id, data: { restrictedRoles: [] } },
                              { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListChannelsQueryKey(serverId) }) }
                            )}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-red-400 border border-red-400/30 hover:bg-red-400/10 transition-colors"
                          >
                            <X className="w-2.5 h-2.5" />Sin restricción
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── MEMBERS TAB ───────────────────────────── */}
          {activeTab === 'members' && (
            <div className="space-y-3">
              {roles.length === 0 && (
                <p className="text-sm text-muted-foreground font-mono text-center py-4">Crea roles primero para poder asignarlos.</p>
              )}
              {members.map((member) => (
                <div key={member.id} className="border border-white/5 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                      {member.user?.avatarUrl
                        ? <img src={sameOriginUploadUrl(member.user.avatarUrl)} className="w-full h-full object-cover" alt="" />
                        : <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-mono">{member.user?.displayName?.substring(0, 2).toUpperCase()}</div>
                      }
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{member.user?.displayName}</p>
                      <p className="text-xs text-muted-foreground font-mono">@{member.user?.username} · {member.role}</p>
                    </div>
                  </div>
                  {roles.length > 0 && canManage && member.userId !== currentUserId && (
                    <div className="flex flex-wrap gap-2 pl-11">
                      {roles.map((role) => {
                        const hasThisRole = member.roles?.some((r: any) => r.id === role.id);
                        return (
                          <button
                            key={role.id}
                            onClick={() => handleToggleMemberRole(member, role)}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${hasThisRole ? 'border-transparent text-white' : 'border-white/20 text-muted-foreground hover:border-white/40 hover:text-foreground'}`}
                            style={hasThisRole ? { backgroundColor: role.color + '33', borderColor: role.color, color: role.color } : {}}
                          >
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: role.color }} />
                            {role.name}
                            {hasThisRole && <Check className="w-2.5 h-2.5" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {(!canManage || member.userId === currentUserId) && member.roles?.length > 0 && (
                    <div className="flex flex-wrap gap-1 pl-11">
                      {member.roles.map((r: any) => (
                        <span key={r.id} className="px-2 py-0.5 rounded-full text-xs" style={{ backgroundColor: r.color + '33', color: r.color, border: `1px solid ${r.color}` }}>
                          {r.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── APARIENCIA TAB ────────────────────────── */}
          {activeTab === 'apariencia' && (
            <div className="space-y-6">
              {/* Server Icon */}
              <div className="space-y-3">
                <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Icono del Servidor</label>
                <div className="flex items-center gap-4">
                  <div className="w-20 h-20 rounded-full bg-secondary border border-white/10 overflow-hidden flex items-center justify-center flex-shrink-0">
                    {serverIconUrl
                      ? <img src={sameOriginUploadUrl(serverIconUrl)} className="w-full h-full object-cover" alt="" />
                      : <span className="font-mono font-bold text-xl text-muted-foreground">{serverName.substring(0, 2).toUpperCase()}</span>
                    }
                  </div>
                  <div className="space-y-2">
                    <button
                      onClick={() => iconInputRef.current?.click()}
                      disabled={uploadingIcon}
                      className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/15 text-white rounded-lg text-sm transition-colors disabled:opacity-50"
                    >
                      <ImageIcon className="w-4 h-4" />
                      {uploadingIcon ? 'Subiendo...' : 'Cambiar icono'}
                    </button>
                    <p className="text-xs text-muted-foreground">Recomendado: cuadrado, mín. 128×128 px.</p>
                  </div>
                </div>
                <input ref={iconInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadIcon} />
              </div>

              {/* Server Banner */}
              <div className="space-y-3">
                <label className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Banner del Servidor</label>
                <div
                  className="w-full h-28 rounded-lg border border-white/10 overflow-hidden flex items-center justify-center bg-secondary cursor-pointer hover:border-primary/40 transition-colors group relative"
                  onClick={() => bannerInputRef.current?.click()}
                >
                  {serverBannerUrl ? (
                    <>
                      <img src={sameOriginUploadUrl(serverBannerUrl)} className="w-full h-full object-cover" alt="" />
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                        <p className="text-sm text-white font-mono">Cambiar banner</p>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground group-hover:text-white transition-colors">
                      <ImageIcon className="w-8 h-8" />
                      <p className="text-sm font-mono">Añadir banner (1920×480 recomendado)</p>
                    </div>
                  )}
                </div>
                <input ref={bannerInputRef} type="file" accept="image/*" className="hidden" onChange={handleUploadBanner} />
                {uploadingBanner && (
                  <p className="text-xs text-primary font-mono flex items-center gap-1">
                    <RefreshCw className="w-3 h-3 animate-spin" /> Subiendo banner...
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── INVITACIONES TAB ──────────────────────── */}
          {activeTab === 'invitaciones' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                  Códigos activos para unirse a este servidor
                </p>
                <button
                  onClick={handleCreateInvite}
                  disabled={createInvite.isPending}
                  className="flex items-center gap-2 px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-xs font-mono transition-colors disabled:opacity-50"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Nuevo código
                </button>
              </div>

              {invitesLoading && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <RefreshCw className="w-5 h-5 animate-spin" />
                </div>
              )}

              {!invitesLoading && (invites as any[]).length === 0 && (
                <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
                  <Link2 className="w-10 h-10 opacity-20" />
                  <p className="text-sm font-mono">No hay invitaciones activas.</p>
                </div>
              )}

              <div className="space-y-2">
                {(invites as any[]).map((invite) => (
                  <div key={invite.id} className="flex items-center gap-3 px-4 py-3 bg-white/5 rounded-lg border border-white/5 group">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-mono text-foreground tracking-wider">{invite.code}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Creado {new Date(invite.createdAt).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' })}
                        {invite.usedById && ' · Usado'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => copyCode(invite.code)}
                        className="p-1.5 text-muted-foreground hover:text-white hover:bg-white/10 rounded-md transition-colors"
                        title="Copiar código"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      {canManage && (
                        <button
                          onClick={() => handleRevokeInvite(invite.code)}
                          className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors"
                          title="Revocar"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── MUTES TAB ─────────────────────────────── */}
          {activeTab === 'mutes' && canManage && (
            <div className="space-y-6">
              {/* Add mute form */}
              <div className="border border-white/10 rounded-xl p-5 bg-secondary/30 space-y-4">
                <h3 className="text-sm font-semibold text-foreground font-mono uppercase tracking-wider">Silenciar usuario</h3>
                <div className="grid grid-cols-2 gap-3">
                  <input value={muteTargetUsername} onChange={e => setMuteTargetUsername(e.target.value)} placeholder="Nombre de usuario" className="bg-background border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 col-span-2" />
                  <select value={muteDuration} onChange={e => setMuteDuration(e.target.value)} className="bg-background border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none">
                    <option value="5">5 minutos</option>
                    <option value="30">30 minutos</option>
                    <option value="60">1 hora</option>
                    <option value="360">6 horas</option>
                    <option value="1440">1 día</option>
                    <option value="10080">1 semana</option>
                  </select>
                  <input value={muteReason} onChange={e => setMuteReason(e.target.value)} placeholder="Motivo (opcional)" className="bg-background border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none" />
                </div>
                <button onClick={handleMuteUser} disabled={!muteTargetUsername.trim() || mutingUser} className="bg-orange-500 hover:bg-orange-600 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-40">
                  {mutingUser ? 'Silenciando…' : 'Silenciar'}
                </button>
              </div>
              {/* Active mutes */}
              <div className="space-y-2">
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Silenciados activos ({mutes.length})</h3>
                {mutes.length === 0 ? <p className="text-sm text-muted-foreground text-center py-4 font-mono">Sin usuarios silenciados.</p> :
                  mutes.map(m => (
                    <div key={m.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-white/5 bg-white/5">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">{m.user.displayName}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          Hasta: {new Date(m.expiresAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}
                          {m.reason && ` — ${m.reason}`}
                        </p>
                      </div>
                      <button onClick={() => handleUnmute(m.id)} className="px-3 py-1.5 text-xs text-orange-400 hover:bg-orange-400/10 rounded-lg transition-colors border border-orange-400/20">Quitar</button>
                    </div>
                  ))
                }
              </div>
            </div>
          )}

          {/* ── WORD FILTERS TAB ──────────────────────── */}
          {activeTab === 'word_filters' && canManage && (
            <div className="space-y-6">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Las palabras filtradas son censuradas automáticamente con *** en los mensajes del servidor.</p>
                <div className="flex gap-2">
                  <input value={newWord} onChange={e => setNewWord(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddWord()} placeholder="Añadir palabra o frase…" className="flex-1 bg-secondary border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50" />
                  <button onClick={handleAddWord} disabled={!newWord.trim()} className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-colors disabled:opacity-40">Añadir</button>
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Palabras filtradas ({wordFilters.length})</h3>
                {wordFilters.length === 0 ? <p className="text-sm text-muted-foreground text-center py-4 font-mono">Sin filtros activos.</p> :
                  <div className="flex flex-wrap gap-2">
                    {wordFilters.map(f => (
                      <div key={f.id} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-sm">
                        <span className="text-foreground font-mono">{f.word}</span>
                        <button onClick={() => handleRemoveWord(f.id)} className="text-muted-foreground hover:text-red-400 transition-colors ml-1 text-xs">✕</button>
                      </div>
                    ))}
                  </div>
                }
              </div>
            </div>
          )}

          {/* ── REPORTS TAB ───────────────────────────── */}
          {activeTab === 'reports' && canManage && (
            <div className="space-y-4">
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Reportes pendientes ({reports.length})</h3>
              {reports.length === 0 ? <p className="text-sm text-muted-foreground text-center py-8 font-mono">Sin reportes pendientes.</p> :
                reports.map(r => (
                  <div key={r.id} className="border border-white/10 rounded-xl p-4 space-y-3 bg-white/5">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-foreground">Mensaje de <span className="text-primary">{r.messageAuthor.displayName}</span></p>
                        <p className="text-xs text-muted-foreground font-mono">Reportado por: {r.reporter.username}</p>
                        <p className="text-xs text-muted-foreground mt-1 italic">"{r.reason}"</p>
                      </div>
                      <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full ${r.status === 'pending' ? 'bg-orange-400/10 text-orange-400' : 'bg-green-400/10 text-green-400'}`}>{r.status}</span>
                    </div>
                    {r.status === 'pending' && (
                      <div className="flex gap-2">
                        <button onClick={() => handleResolveReport(r.id, 'dismiss')} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground border border-white/10 hover:border-white/20 rounded-lg transition-colors">Descartar</button>
                        <button onClick={() => handleResolveReport(r.id, 'delete_message')} className="px-3 py-1.5 text-xs text-red-400 hover:bg-red-400/10 border border-red-400/20 rounded-lg transition-colors">Eliminar mensaje</button>
                      </div>
                    )}
                  </div>
                ))
              }
            </div>
          )}

          {/* ── AUDIT LOG TAB ─────────────────────────── */}
          {activeTab === 'audit' && canManage && (
            <div className="space-y-3">
              <h3 className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Registro de moderación ({auditLog.length})</h3>
              {auditLog.length === 0 ? <p className="text-sm text-muted-foreground text-center py-8 font-mono">Sin entradas de registro.</p> :
                <div className="space-y-2">
                  {auditLog.map(entry => (
                    <div key={entry.id} className="flex items-start gap-3 px-4 py-3 rounded-xl border border-white/5 bg-white/[0.03]">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-mono font-bold text-primary uppercase">{entry.action.replace(/_/g, ' ')}</span>
                          <span className="text-[10px] text-muted-foreground font-mono">{new Date(entry.createdAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {entry.actor ? <span className="text-foreground">{entry.actor.displayName}</span> : 'Sistema'}
                          {entry.target ? <> → <span className="text-foreground">{entry.target.displayName}</span></> : null}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              }
            </div>
          )}

          {/* ── PELIGRO TAB ───────────────────────────── */}
          {activeTab === 'peligro' && !isGeneral && isOwner && (
            <div className="space-y-6">
              <div className="border border-red-500/30 rounded-xl p-5 bg-red-500/5 space-y-4">
                <div className="flex items-center gap-2 text-red-400">
                  <AlertTriangle className="w-5 h-5" />
                  <h3 className="font-bold font-mono uppercase tracking-wider text-sm">Eliminar servidor</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  Esta acción es <strong className="text-foreground">permanente e irreversible</strong>. 
                  Se eliminarán todos los canales, mensajes, roles e invitaciones de este servidor.
                </p>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
                    Escribe <span className="text-foreground font-semibold">{serverName}</span> para confirmar
                  </label>
                  <input
                    type="text"
                    value={deleteConfirmName}
                    onChange={e => setDeleteConfirmName(e.target.value)}
                    placeholder={serverName}
                    className="w-full bg-background border border-red-500/30 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-red-500/60 placeholder:text-muted-foreground"
                  />
                </div>
                <button
                  onClick={handleDeleteServer}
                  disabled={deleteConfirmName !== serverName || deleting}
                  className="w-full bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg py-2.5 text-sm font-bold font-mono uppercase tracking-wider transition-colors flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  {deleting ? 'Eliminando...' : 'Eliminar servidor definitivamente'}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
