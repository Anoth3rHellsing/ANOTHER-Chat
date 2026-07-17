import { useState } from 'react';
import { useLocation } from 'wouter';
import { 
  useListInvites, useGenerateInvite, useRevokeInvite,
  useListAllUsers, useBanUser, useUnbanUser, useKickUser,
  useGetAdminStats
} from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Shield, Key, Users, Activity, Trash2, Ban, ShieldAlert, ArrowLeft, Loader2, RefreshCw } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

export default function AdminPanel() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<'stats' | 'invites' | 'users'>('stats');

  const { data: stats, isLoading: statsLoading } = useGetAdminStats({ query: { enabled: activeTab === 'stats' } });
  const { data: invites, refetch: refetchInvites, isLoading: invitesLoading } = useListInvites({ query: { enabled: activeTab === 'invites' } });
  const { data: users, refetch: refetchUsers, isLoading: usersLoading } = useListAllUsers({ query: { enabled: activeTab === 'users' } });

  const generateInvite = useGenerateInvite();
  const revokeInvite = useRevokeInvite();
  const banUser = useBanUser();
  const unbanUser = useUnbanUser();
  const kickUser = useKickUser();

  const handleGenerateInvite = () => {
    generateInvite.mutate({ data: {} }, {
      onSuccess: () => {
        refetchInvites();
        toast({ title: "Código generado" });
      }
    });
  };

  const StatCard = ({ title, value, icon: Icon }: any) => (
    <div className="bg-card border border-white/5 p-6 rounded-xl flex items-center gap-4">
      <div className="p-4 bg-primary/10 rounded-lg text-primary">
        <Icon className="w-6 h-6" />
      </div>
      <div>
        <p className="text-sm font-mono text-muted-foreground uppercase">{title}</p>
        <p className="text-3xl font-bold text-foreground">{value ?? '-'}</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="h-16 border-b border-white/5 flex items-center px-6 gap-4 bg-card/30">
        <button onClick={() => setLocation('/app')} className="p-2 hover:bg-white/5 rounded-lg transition-colors text-muted-foreground hover:text-white">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <ShieldAlert className="w-6 h-6 text-primary" />
        <h1 className="text-xl font-bold font-mono tracking-tight">Terminal de Administración</h1>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-64 border-r border-white/5 bg-card/20 p-4 space-y-2">
          <button 
            onClick={() => setActiveTab('stats')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all text-sm font-medium ${activeTab === 'stats' ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent'}`}
          >
            <Activity className="w-4 h-4" /> Estadísticas
          </button>
          <button 
            onClick={() => setActiveTab('invites')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all text-sm font-medium ${activeTab === 'invites' ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent'}`}
          >
            <Key className="w-4 h-4" /> Códigos de Acceso
          </button>
          <button 
            onClick={() => setActiveTab('users')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all text-sm font-medium ${activeTab === 'users' ? 'bg-primary/10 text-primary border border-primary/20' : 'text-muted-foreground hover:bg-white/5 hover:text-white border border-transparent'}`}
          >
            <Users className="w-4 h-4" /> Directorio de Operarios
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-8 overflow-y-auto">
          {activeTab === 'stats' && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold font-mono">Telemetría del Sistema</h2>
              {statsLoading ? <Loader2 className="w-8 h-8 animate-spin text-primary" /> : (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
                  <StatCard title="Operarios" value={stats?.userCount} icon={Users} />
                  <StatCard title="Conectados" value={stats?.activeUserCount} icon={Activity} />
                  <StatCard title="Servidores" value={stats?.serverCount} icon={Shield} />
                  <StatCard title="Mensajes" value={stats?.messageCount} icon={Trash2} />
                </div>
              )}
            </div>
          )}

          {activeTab === 'invites' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl font-bold font-mono">Control de Acceso</h2>
                <button 
                  onClick={handleGenerateInvite}
                  disabled={generateInvite.isPending}
                  className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2"
                >
                  {generateInvite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                  Generar Nuevo Código
                </button>
              </div>
              
              <div className="bg-card border border-white/5 rounded-xl overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-black/20 text-muted-foreground font-mono uppercase text-xs">
                    <tr>
                      <th className="px-6 py-4">Código</th>
                      <th className="px-6 py-4">Estado</th>
                      <th className="px-6 py-4">Creado</th>
                      <th className="px-6 py-4">Uso</th>
                      <th className="px-6 py-4 text-right">Acción</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {invitesLoading ? (
                      <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Cargando...</td></tr>
                    ) : invites?.length === 0 ? (
                      <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No hay códigos activos.</td></tr>
                    ) : (
                      invites?.map(inv => (
                        <tr key={inv.code} className="hover:bg-white/[0.02]">
                          <td className="px-6 py-4 font-mono text-primary">{inv.code}</td>
                          <td className="px-6 py-4">
                            {inv.revoked ? <span className="text-destructive text-xs uppercase tracking-wide">Revocado</span> : 
                             inv.usedById ? <span className="text-muted-foreground text-xs uppercase tracking-wide">Usado</span> : 
                             <span className="text-green-500 text-xs uppercase tracking-wide">Activo</span>}
                          </td>
                          <td className="px-6 py-4 text-muted-foreground">
                            {format(new Date(inv.createdAt), 'dd MMM yyyy', { locale: es })}
                          </td>
                          <td className="px-6 py-4 text-muted-foreground">
                            {inv.usedAt ? format(new Date(inv.usedAt), 'dd MMM yyyy', { locale: es }) : '-'}
                          </td>
                          <td className="px-6 py-4 text-right">
                            {!inv.revoked && !inv.usedById && (
                              <button 
                                onClick={() => revokeInvite.mutate({ code: inv.code }, { onSuccess: () => refetchInvites() })}
                                className="text-destructive hover:text-destructive/80 transition-colors p-2"
                                title="Revocar código"
                              >
                                <Ban className="w-4 h-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'users' && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold font-mono">Directorio de Operarios</h2>
              <div className="bg-card border border-white/5 rounded-xl overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-black/20 text-muted-foreground font-mono uppercase text-xs">
                    <tr>
                      <th className="px-6 py-4">Identificación</th>
                      <th className="px-6 py-4">Rol</th>
                      <th className="px-6 py-4">Estado</th>
                      <th className="px-6 py-4 text-right">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {usersLoading ? (
                      <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">Cargando...</td></tr>
                    ) : users?.length === 0 ? (
                      <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">No hay operarios.</td></tr>
                    ) : (
                      users?.map(u => (
                        <tr key={u.id} className="hover:bg-white/[0.02]">
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden">
                                {u.avatarUrl ? <img src={u.avatarUrl} className="w-full h-full object-cover" alt="" /> : <Users className="w-4 h-4 m-2 text-muted-foreground" />}
                              </div>
                              <div>
                                <p className="font-medium text-foreground">{u.displayName}</p>
                                <p className="font-mono text-xs text-muted-foreground">@{u.username}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 text-xs font-mono uppercase">
                            <span className={u.role === 'admin' ? 'text-primary' : 'text-muted-foreground'}>{u.role}</span>
                          </td>
                          <td className="px-6 py-4 text-xs font-mono uppercase">
                            {u.banned ? <span className="text-destructive">Baneado</span> : <span className="text-green-500">Activo</span>}
                          </td>
                          <td className="px-6 py-4 text-right">
                            {u.role !== 'admin' && (
                              <div className="flex items-center justify-end gap-2">
                                <button 
                                  onClick={() => kickUser.mutate({ userId: u.id }, { onSuccess: () => { refetchUsers(); toast({ title: "Usuario expulsado" }); } })}
                                  className="text-yellow-500 hover:text-yellow-400 p-2 transition-colors"
                                  title="Expulsar"
                                >
                                  <RefreshCw className="w-4 h-4" />
                                </button>
                                {u.banned ? (
                                  <button 
                                    onClick={() => unbanUser.mutate({ userId: u.id }, { onSuccess: () => { refetchUsers(); toast({ title: "Baneo levantado" }); } })}
                                    className="text-green-500 hover:text-green-400 p-2 transition-colors"
                                    title="Desbanear"
                                  >
                                    <Shield className="w-4 h-4" />
                                  </button>
                                ) : (
                                  <button 
                                    onClick={() => banUser.mutate({ userId: u.id }, { onSuccess: () => { refetchUsers(); toast({ title: "Usuario baneado" }); } })}
                                    className="text-destructive hover:text-destructive/80 p-2 transition-colors"
                                    title="Banear"
                                  >
                                    <Ban className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}