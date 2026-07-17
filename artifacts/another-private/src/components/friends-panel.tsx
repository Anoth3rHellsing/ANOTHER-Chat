import { useState, useEffect } from 'react';
import { UserPlus, Check, X, MessageSquare, Users as UsersIcon, Clock, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Friend {
  id: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  status: string;
  customStatus?: string | null;
  statusEmoji?: string | null;
}

interface FriendRequest {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  createdAt: string;
}

interface FriendsPanelProps {
  onOpenDm: (userId: number) => void;
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

const STATUS_DOT: Record<string, string> = {
  online: 'bg-green-500',
  away: 'bg-yellow-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-500',
};

export function FriendsPanel({ onOpenDm }: FriendsPanelProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState<'friends' | 'requests' | 'add'>('friends');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [addUsername, setAddUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchFriends = async () => {
    try {
      const [fr, rq] = await Promise.all([
        fetch(`${BASE}/api/friends`, { credentials: 'include' }).then(r => r.json()),
        fetch(`${BASE}/api/friends/requests`, { credentials: 'include' }).then(r => r.json()),
      ]);
      setFriends(Array.isArray(fr) ? fr : []);
      setIncoming(Array.isArray(rq?.incoming) ? rq.incoming : []);
      setOutgoing(Array.isArray(rq?.outgoing) ? rq.outgoing : []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchFriends(); }, []);

  const sendRequest = async () => {
    if (!addUsername.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`${BASE}/api/friends/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: addUsername.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        toast({ title: data.accepted ? '¡Ahora son amigos!' : 'Solicitud enviada' });
        setAddUsername('');
        fetchFriends();
      } else {
        toast({ title: data.error ?? 'Error', variant: 'destructive' });
      }
    } catch {}
    setAdding(false);
  };

  const acceptRequest = async (id: number) => {
    await fetch(`${BASE}/api/friends/requests/${id}/accept`, { method: 'POST', credentials: 'include' });
    fetchFriends();
  };

  const rejectRequest = async (id: number) => {
    await fetch(`${BASE}/api/friends/requests/${id}/reject`, { method: 'POST', credentials: 'include' });
    fetchFriends();
  };

  const removeFriend = async (friendId: number) => {
    await fetch(`${BASE}/api/friends/${friendId}`, { method: 'DELETE', credentials: 'include' });
    setFriends(prev => prev.filter(f => f.id !== friendId));
  };

  const pendingCount = incoming.length;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="h-12 border-b border-white/5 flex items-center px-4 bg-card/30 backdrop-blur-sm flex-shrink-0">
        <UsersIcon className="w-4 h-4 text-indigo-400 mr-2" />
        <span className="font-medium text-foreground">Amigos</span>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-white/5 px-3 gap-1 flex-shrink-0 bg-card/10">
        {(['friends', 'requests', 'add'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-xs font-mono uppercase tracking-wider rounded-t relative transition-colors ${tab === t ? 'text-foreground border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t === 'friends' ? 'Amigos' : t === 'requests' ? 'Solicitudes' : 'Añadir'}
            {t === 'requests' && pendingCount > 0 && (
              <span className="ml-1 inline-flex items-center justify-center w-4 h-4 bg-red-500 text-white text-[10px] rounded-full font-bold">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Friends tab */}
        {tab === 'friends' && (
          <>
            {loading ? (
              <div className="text-center text-muted-foreground text-sm font-mono py-8">Cargando…</div>
            ) : friends.length === 0 ? (
              <div className="text-center py-12 space-y-2 text-muted-foreground">
                <UsersIcon className="w-12 h-12 mx-auto opacity-20" />
                <p className="text-sm font-mono">Sin amigos todavía.</p>
                <button onClick={() => setTab('add')} className="text-sm text-primary hover:underline">Añadir amigos</button>
              </div>
            ) : (
              <div className="space-y-1">
                {friends.map(f => (
                  <div key={f.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 group transition-colors">
                    <div className="relative flex-shrink-0">
                      <div className="w-10 h-10 rounded-full bg-secondary overflow-hidden">
                        {f.avatarUrl ? <img src={f.avatarUrl} className="w-full h-full object-cover" alt="" /> : <UsersIcon className="w-5 h-5 m-2.5 text-muted-foreground" />}
                      </div>
                      <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-card ${STATUS_DOT[f.status] ?? 'bg-gray-500'}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{f.displayName}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">
                        {f.statusEmoji && <span className="mr-1">{f.statusEmoji}</span>}
                        {f.customStatus ?? f.status}
                      </p>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => onOpenDm(f.id)} className="p-1.5 text-muted-foreground hover:text-indigo-400 hover:bg-indigo-400/10 rounded-lg transition-colors" title="Mensaje directo">
                        <MessageSquare className="w-4 h-4" />
                      </button>
                      <button onClick={() => removeFriend(f.id)} className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors" title="Eliminar amigo">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Requests tab */}
        {tab === 'requests' && (
          <div className="space-y-4">
            {incoming.length > 0 && (
              <div>
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Recibidas ({incoming.length})</p>
                <div className="space-y-1">
                  {incoming.map(r => (
                    <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/5">
                      <div className="w-9 h-9 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                        {r.avatarUrl && <img src={r.avatarUrl} className="w-full h-full object-cover" alt="" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">{r.displayName}</p>
                        <p className="text-xs text-muted-foreground font-mono">@{r.username}</p>
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => acceptRequest(r.id)} className="p-1.5 text-green-400 hover:bg-green-400/10 rounded-lg transition-colors" title="Aceptar">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={() => rejectRequest(r.id)} className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors" title="Rechazar">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {outgoing.length > 0 && (
              <div>
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider mb-2">Enviadas ({outgoing.length})</p>
                <div className="space-y-1">
                  {outgoing.map(r => (
                    <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/5">
                      <div className="w-9 h-9 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                        {r.avatarUrl && <img src={r.avatarUrl} className="w-full h-full object-cover" alt="" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">{r.displayName}</p>
                        <p className="text-xs text-muted-foreground font-mono">@{r.username}</p>
                      </div>
                      <Clock className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {incoming.length === 0 && outgoing.length === 0 && (
              <p className="text-center text-muted-foreground text-sm font-mono py-8">Sin solicitudes pendientes.</p>
            )}
          </div>
        )}

        {/* Add tab */}
        {tab === 'add' && (
          <div className="space-y-4 max-w-sm mx-auto pt-4">
            <div>
              <p className="text-sm text-foreground font-medium mb-1">Añadir por nombre de usuario</p>
              <p className="text-xs text-muted-foreground mb-3">Introduce el nombre exacto del usuario (ej. <span className="font-mono text-foreground">usuario123</span>).</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={addUsername}
                  onChange={e => setAddUsername(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendRequest()}
                  placeholder="nombre_de_usuario"
                  className="flex-1 bg-secondary border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 font-mono"
                  autoFocus
                />
                <button
                  onClick={sendRequest}
                  disabled={!addUsername.trim() || adding}
                  className="px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {adding ? '…' : 'Enviar'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
