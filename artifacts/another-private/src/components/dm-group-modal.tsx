import { useState, useEffect } from 'react';
import { X, Users as UsersIcon, Plus, Check } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface User {
  id: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}

interface DmGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUserId: number;
  friends: User[];
  onCreated: (group: { id: number; name: string }) => void;
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

export function DmGroupModal({ isOpen, onClose, currentUserId, friends, onCreated }: DmGroupModalProps) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (isOpen) { setName(''); setSelected(new Set()); }
  }, [isOpen]);

  if (!isOpen) return null;

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!name.trim() || selected.size === 0) return;
    setCreating(true);
    try {
      const res = await fetch(`${BASE}/api/dm-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim(), memberIds: Array.from(selected) }),
      });
      if (res.ok) {
        const group = await res.json();
        toast({ title: `Grupo "${group.name}" creado` });
        onCreated(group);
        onClose();
      } else {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error ?? 'Error al crear', variant: 'destructive' });
      }
    } catch {}
    setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-white/10 rounded-2xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-2 text-foreground">
            <UsersIcon className="w-5 h-5 text-indigo-400" />
            <span className="font-bold font-mono uppercase tracking-wider text-sm">Nuevo grupo de mensajes</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Nombre del grupo</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Ej. Equipo operativo"
              className="w-full mt-1 bg-secondary border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2 block">
              Seleccionar miembros {selected.size > 0 && `(${selected.size} seleccionados)`}
            </label>
            {friends.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">Sin amigos disponibles. Añade amigos primero.</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {friends.map(f => (
                  <button
                    key={f.id}
                    onClick={() => toggle(f.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${selected.has(f.id) ? 'bg-primary/20 border border-primary/30' : 'hover:bg-white/5 border border-transparent'}`}
                  >
                    <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                      {f.avatarUrl && <img src={f.avatarUrl} className="w-full h-full object-cover" alt="" />}
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-medium text-foreground truncate">{f.displayName}</p>
                      <p className="text-xs text-muted-foreground font-mono">@{f.username}</p>
                    </div>
                    {selected.has(f.id) && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleCreate}
              disabled={!name.trim() || selected.size === 0 || creating}
              className="flex-1 bg-primary hover:bg-primary/90 text-white rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-40"
            >
              {creating ? 'Creando…' : 'Crear grupo'}
            </button>
            <button onClick={onClose} className="px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground">
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
