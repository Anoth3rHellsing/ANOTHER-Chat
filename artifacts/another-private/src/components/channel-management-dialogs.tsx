import { useEffect, useState } from 'react';
import {
  useUpdateChannel,
  useDeleteChannel,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useListServerRoles,
  ApiError,
  type Channel,
  type Category,
  type ChannelUpdate,
} from '@workspace/api-client-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { normalizeChannelName } from '@/lib/channel-name';

type ChannelWithExtras = Channel & { channelType?: string; restrictedRoles?: number[] };

/** El mensaje real del servidor (en español), no una cadena fija (AGENTS.md §10). */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown } | null;
    if (data && typeof data.error === 'string' && data.error.trim()) return data.error;
    if (error.status === 403) return 'No tienes permiso para hacer esto.';
  }
  return 'No se pudo completar la acción. Inténtalo de nuevo.';
}

const INPUT = 'w-full rounded-lg border border-white/10 bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none';
const LABEL = 'text-xs font-bold uppercase tracking-wider text-muted-foreground';
const PRIMARY = 'rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';
const SECONDARY = 'rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground';
const DANGER = 'rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50';

// ── Editar canal: nombre, categoría y roles con acceso ─────────────────────
export function EditChannelDialog({
  serverId,
  channel,
  categories,
  onClose,
  onSaved,
}: {
  serverId: number;
  channel: ChannelWithExtras | null;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [roles, setRoles] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const updateChannel = useUpdateChannel();
  const { data: serverRoles = [] } = useListServerRoles(serverId, { query: { enabled: channel !== null } as never });

  useEffect(() => {
    if (!channel) return;
    setName(channel.name);
    setCategoryId(channel.categoryId ?? null);
    setRoles(channel.restrictedRoles ?? []);
    setError(null);
  }, [channel]);

  const normalized = normalizeChannelName(name);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!channel || !normalized) return;
    const data: ChannelUpdate = {};
    if (normalized !== channel.name) data.name = normalized;
    if (categoryId !== (channel.categoryId ?? null)) data.categoryId = categoryId;
    const before = [...(channel.restrictedRoles ?? [])].sort().join(',');
    if ([...roles].sort().join(',') !== before) data.restrictedRoles = roles;
    if (Object.keys(data).length === 0) { onClose(); return; }
    updateChannel.mutate({ channelId: channel.id, data }, {
      onSuccess: () => { onSaved(); onClose(); },
      onError: err => setError(apiErrorMessage(err)),
    });
  };

  return (
    <Dialog open={channel !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>Editar canal</DialogTitle>
            <DialogDescription>El tipo de canal no se puede cambiar después de crearlo.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="edit-channel-name" className={LABEL}>Nombre</label>
            <input
              id="edit-channel-name"
              value={name}
              maxLength={100}
              onChange={e => setName(e.target.value)}
              className={INPUT}
              autoFocus
            />
            {normalized !== name && normalized && (
              <p className="text-xs text-muted-foreground">Se guardará como <span className="font-mono">{normalized}</span></p>
            )}
          </div>
          <div className="space-y-2">
            <label htmlFor="edit-channel-category" className={LABEL}>Categoría</label>
            <select
              id="edit-channel-category"
              value={categoryId ?? ''}
              onChange={e => setCategoryId(e.target.value ? Number(e.target.value) : null)}
              className={INPUT}
            >
              <option value="">Sin categoría</option>
              {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </div>
          {serverRoles.length > 0 && (
            <fieldset className="space-y-2">
              <legend className={LABEL}>Roles con acceso</legend>
              <p className="text-xs text-muted-foreground">Sin ninguno marcado, el canal es visible para todo el servidor.</p>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-white/10 p-2">
                {serverRoles.map(role => (
                  <label key={role.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={roles.includes(role.id)}
                      onChange={e => setRoles(current => e.target.checked ? [...current, role.id] : current.filter(id => id !== role.id))}
                      className="accent-primary"
                    />
                    <span className="truncate">{role.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={onClose} className={SECONDARY}>Cancelar</button>
            <button type="submit" disabled={!normalized || updateChannel.isPending} className={PRIMARY}>
              {updateChannel.isPending ? 'Guardando…' : 'Guardar'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Eliminar canal: hay que escribir su nombre ─────────────────────────────
const LOSSES: Record<string, string> = {
  text: 'Se borrarán todos sus mensajes, adjuntos y reacciones.',
  media: 'Se borrarán todos sus archivos.',
  calendar: 'Se borrarán todos sus eventos.',
  voice: 'Se borrará el canal, y quien esté dentro saldrá de la llamada.',
};

export function DeleteChannelDialog({
  channel,
  onClose,
  onDeleted,
}: {
  channel: ChannelWithExtras | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const deleteChannel = useDeleteChannel();
  useEffect(() => { setTyped(''); setError(null); }, [channel]);

  const confirm = () => {
    if (!channel || typed !== channel.name) return;
    deleteChannel.mutate({ channelId: channel.id }, {
      onSuccess: () => { onDeleted(); onClose(); },
      onError: err => setError(apiErrorMessage(err)),
    });
  };

  return (
    <AlertDialog open={channel !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Eliminar #{channel?.name}</AlertDialogTitle>
          <AlertDialogDescription>
            {LOSSES[channel?.channelType ?? 'text'] ?? LOSSES.text} No se puede deshacer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <label htmlFor="delete-channel-confirm" className="text-sm text-muted-foreground">
            Escribe <span className="font-mono text-foreground">{channel?.name}</span> para confirmar
          </label>
          <input
            id="delete-channel-confirm"
            value={typed}
            onChange={e => setTyped(e.target.value)}
            autoComplete="off"
            className={INPUT}
          />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel className={SECONDARY}>Cancelar</AlertDialogCancel>
          <button
            type="button"
            onClick={confirm}
            disabled={!channel || typed !== channel.name || deleteChannel.isPending}
            className={DANGER}
          >
            {deleteChannel.isPending ? 'Eliminando…' : 'Eliminar canal'}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Crear o renombrar categoría ────────────────────────────────────────────
export function CategoryNameDialog({
  serverId,
  state,
  onClose,
  onSaved,
}: {
  serverId: number;
  state: { mode: 'create' } | { mode: 'rename'; category: Category } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  useEffect(() => {
    setName(state?.mode === 'rename' ? state.category.name : '');
    setError(null);
  }, [state]);

  const trimmed = name.trim();
  const pending = createCategory.isPending || updateCategory.isPending;
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!state || !trimmed) return;
    const done = { onSuccess: () => { onSaved(); onClose(); }, onError: (err: unknown) => setError(apiErrorMessage(err)) };
    if (state.mode === 'create') createCategory.mutate({ serverId, data: { name: trimmed } }, done);
    else updateCategory.mutate({ categoryId: state.category.id, data: { name: trimmed } }, done);
  };

  return (
    <Dialog open={state !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{state?.mode === 'rename' ? 'Renombrar categoría' : 'Crear categoría'}</DialogTitle>
            <DialogDescription>Las categorías agrupan canales en la barra lateral.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="category-name" className={LABEL}>Nombre</label>
            <input id="category-name" value={name} maxLength={100} onChange={e => setName(e.target.value)} className={INPUT} autoFocus />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={onClose} className={SECONDARY}>Cancelar</button>
            <button type="submit" disabled={!trimmed || pending} className={PRIMARY}>
              {pending ? 'Guardando…' : state?.mode === 'rename' ? 'Guardar' : 'Crear'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Eliminar categoría: sus canales pasan a "Sin categoría" ────────────────
export function DeleteCategoryDialog({
  category,
  channelCount,
  onClose,
  onDeleted,
}: {
  category: Category | null;
  channelCount: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const deleteCategory = useDeleteCategory();
  useEffect(() => { setError(null); }, [category]);
  const confirm = () => {
    if (!category) return;
    deleteCategory.mutate({ categoryId: category.id }, {
      onSuccess: () => { onDeleted(); onClose(); },
      onError: err => setError(apiErrorMessage(err)),
    });
  };
  return (
    <AlertDialog open={category !== null} onOpenChange={open => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Eliminar la categoría «{category?.name}»</AlertDialogTitle>
          <AlertDialogDescription>
            {channelCount === 0
              ? 'La categoría está vacía.'
              : `${channelCount === 1 ? 'Su único canal pasará' : `Sus ${channelCount} canales pasarán`} a «Sin categoría». No se borra ningún canal.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel className={SECONDARY}>Cancelar</AlertDialogCancel>
          <button type="button" onClick={confirm} disabled={deleteCategory.isPending} className={DANGER}>
            {deleteCategory.isPending ? 'Eliminando…' : 'Eliminar categoría'}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
