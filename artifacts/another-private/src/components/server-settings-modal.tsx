import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListServerRoles,
  useCreateServerRole,
  useUpdateServerRole,
  useDeleteServerRole,
  useAssignMemberRole,
  useRemoveMemberRole,
  useUpdateChannel,
  useListChannels,
  getListServerRolesQueryKey,
  getGetServerMembersQueryKey,
  getListChannelsQueryKey,
} from '@workspace/api-client-react';
import { X, Plus, Trash2, Check, Shield, Hash, Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { PERM, PERM_LABELS, hasPerm } from '@/lib/permissions';

interface ServerSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: number;
  serverName: string;
  members: any[];
  currentUserId: number;
  currentUserMembershipRole: string;
}

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#ef4444',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#06b6d4', '#a855f7', '#64748b',
];

export function ServerSettingsModal({
  isOpen,
  onClose,
  serverId,
  serverName,
  members,
  currentUserId,
  currentUserMembershipRole,
}: ServerSettingsModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'roles' | 'channels' | 'members'>('roles');

  const { data: roles = [] } = useListServerRoles(serverId, { query: { enabled: isOpen && !!serverId } as any });
  const { data: channels = [] } = useListChannels(serverId, { query: { enabled: isOpen && !!serverId } as any });
  const updateChannel = useUpdateChannel();

  const createRole = useCreateServerRole();
  const updateRole = useUpdateServerRole();
  const deleteRole = useDeleteServerRole();
  const assignRole = useAssignMemberRole();
  const removeRole = useRemoveMemberRole();

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
      removeRole.mutate(
        { serverId, userId: member.userId, roleId: role.id },
        { onSuccess: invalidateRoles }
      );
    } else {
      assignRole.mutate(
        { serverId, userId: member.userId, roleId: role.id },
        { onSuccess: invalidateRoles }
      );
    }
  };

  if (!isOpen) return null;

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
        <div className="flex border-b border-white/10 flex-shrink-0">
          {(['roles', 'channels', 'members'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-sm font-mono uppercase tracking-wider transition-colors ${
                activeTab === tab
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'roles' ? 'Roles' : tab === 'channels' ? 'Canales' : 'Miembros'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'roles' && (
            <div className="space-y-4">
              {/* Role list */}
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
                    {(currentUserMembershipRole === 'owner' || currentUserMembershipRole === 'admin') && (
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
                  <p className="text-sm text-muted-foreground font-mono text-center py-4">
                    No hay roles personalizados todavía.
                  </p>
                )}
              </div>

              {/* Role editor */}
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
                          className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
                            roleColor === c ? 'border-white scale-110' : 'border-transparent'
                          }`}
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
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                              hasPerm(rolePermissions, flag)
                                ? 'border-primary bg-primary'
                                : 'border-white/20 bg-transparent group-hover:border-white/40'
                            }`}
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
                      className="flex-1 bg-primary hover:bg-primary/90 text-white rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {isCreating ? 'Crear' : 'Guardar'}
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              {(currentUserMembershipRole === 'owner' || currentUserMembershipRole === 'admin') && !isCreating && editingRoleId === null && (
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

          {activeTab === 'channels' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-4">
                Controla qué roles pueden ver cada canal. Sin restricción = visible para todos.
              </p>
              {channels.length === 0 && (
                <p className="text-sm text-muted-foreground font-mono text-center py-4">
                  No hay canales en este servidor.
                </p>
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
                          <Lock className="w-3 h-3" />
                          restringido
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
                              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                                isRestricted ? '' : 'border-white/20 text-muted-foreground hover:border-white/40'
                              }`}
                              style={isRestricted ? {
                                backgroundColor: role.color + '33',
                                borderColor: role.color,
                                color: role.color,
                              } : {}}
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
                            <X className="w-2.5 h-2.5" />
                            Sin restricción
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'members' && (
            <div className="space-y-3">
              {roles.length === 0 && (
                <p className="text-sm text-muted-foreground font-mono text-center py-4">
                  Crea roles primero para poder asignarlos.
                </p>
              )}
              {members.map((member) => (
                <div key={member.id} className="border border-white/5 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                      {member.user?.avatarUrl ? (
                        <img src={member.user.avatarUrl} className="w-full h-full object-cover" alt="" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground font-mono">
                          {member.user?.displayName?.substring(0, 2).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">{member.user?.displayName}</p>
                      <p className="text-xs text-muted-foreground font-mono">@{member.user?.username} · {member.role}</p>
                    </div>
                  </div>

                  {roles.length > 0 && (currentUserMembershipRole === 'owner' || currentUserMembershipRole === 'admin') && member.userId !== currentUserId && (
                    <div className="flex flex-wrap gap-2 pl-11">
                      {roles.map((role) => {
                        const hasThisRole = member.roles?.some((r: any) => r.id === role.id);
                        return (
                          <button
                            key={role.id}
                            onClick={() => handleToggleMemberRole(member, role)}
                            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border ${
                              hasThisRole
                                ? 'border-transparent text-white'
                                : 'border-white/20 text-muted-foreground hover:border-white/40 hover:text-foreground'
                            }`}
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

                  {/* Show assigned roles if no edit access */}
                  {(currentUserMembershipRole === 'member' || member.userId === currentUserId) && member.roles?.length > 0 && (
                    <div className="flex flex-wrap gap-1 pl-11">
                      {member.roles.map((r: any) => (
                        <span
                          key={r.id}
                          className="px-2 py-0.5 rounded-full text-xs"
                          style={{ backgroundColor: r.color + '33', color: r.color, border: `1px solid ${r.color}` }}
                        >
                          {r.name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
