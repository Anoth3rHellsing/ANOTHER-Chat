import { useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  Hash,
  Volume2,
  Image as ImageIcon,
  Calendar,
  Play,
  Plus,
  MoreVertical,
  Pencil,
  FolderInput,
  ArrowUp,
  ArrowDown,
  Trash2,
  FolderPlus,
} from 'lucide-react';
import {
  useListCategories,
  useReorderChannels,
  useReorderCategories,
  getListChannelsQueryKey,
  getListCategoriesQueryKey,
  type Channel,
  type Category,
  type ChannelReorderItem,
} from '@workspace/api-client-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import {
  EditChannelDialog,
  DeleteChannelDialog,
  CategoryNameDialog,
  DeleteCategoryDialog,
  apiErrorMessage,
} from '@/components/channel-management-dialogs';

const CHANNEL_TYPE_ICON = { text: Hash, voice: Volume2, media: ImageIcon, calendar: Calendar } as const;
const CHANNEL_TYPE_LABEL = { text: 'Texto', voice: 'Voz', media: 'Media', calendar: 'Calendario' } as const;

/** Estilo de foco propio: sustituye al contorno del navegador (el borde amarillo). */
const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-primary/60';
/** Visible al pasar el ratón o con teclado; siempre visible en pantallas táctiles. */
const REVEAL = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100';

type ChannelWithExtras = Channel & {
  channelType?: string;
  visualConfig?: { kind?: string; value?: string };
  restrictedRoles?: number[];
};

interface ChannelSidebarProps {
  serverId: number;
  channels: Channel[];
  activeChannelId: number | null;
  showClips: boolean;
  unreadCounts: Map<number, number>;
  mentionCounts: Map<number, number>;
  canManageChannels: boolean;
  renderVoiceChannel: (channel: Channel, options: { reserveMenuSpace: boolean }) => ReactNode;
  onSelectChannel: (channel: Channel) => void;
  onToggleClips: () => void;
  onCreateChannel: (categoryId: number | null) => void;
}

interface Group {
  category: Category | null;
  channels: ChannelWithExtras[];
}

// ── Plegado de categorías: solo en este navegador ──────────────────────────
function collapsedKey(serverId: number) {
  return `another:collapsed-categories:${serverId}`;
}
function loadCollapsed(serverId: number): Set<number> {
  try {
    const raw = window.localStorage.getItem(collapsedKey(serverId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : []);
  } catch {
    return new Set();
  }
}
function saveCollapsed(serverId: number, collapsed: Set<number>) {
  try {
    window.localStorage.setItem(collapsedKey(serverId), JSON.stringify([...collapsed]));
  } catch {
    // Almacenamiento no disponible (modo privado): el plegado dura solo esta sesión.
  }
}

/**
 * Agrupa los canales: primero los que no tienen categoría, después cada categoría por su
 * posición. Dentro de cada grupo, por posición y, a igualdad, en el orden que dio el servidor.
 */
export function groupChannels(channels: ChannelWithExtras[], categories: Category[]): Group[] {
  const sortedCategories = [...categories].sort((a, b) => a.position - b.position || a.id - b.id);
  const known = new Set(sortedCategories.map(c => c.id));
  const indexed = channels.map((channel, index) => ({ channel, index }));
  const byPosition = (a: { channel: ChannelWithExtras; index: number }, b: { channel: ChannelWithExtras; index: number }) =>
    (a.channel.position ?? 0) - (b.channel.position ?? 0) || a.index - b.index;
  const uncategorized = indexed
    .filter(({ channel }) => channel.categoryId == null || !known.has(channel.categoryId))
    .sort(byPosition)
    .map(({ channel }) => channel);
  const groups: Group[] = [{ category: null, channels: uncategorized }];
  for (const category of sortedCategories) {
    groups.push({
      category,
      channels: indexed
        .filter(({ channel }) => channel.categoryId === category.id)
        .sort(byPosition)
        .map(({ channel }) => channel),
    });
  }
  return groups;
}

export function ChannelSidebar({
  serverId,
  channels,
  activeChannelId,
  showClips,
  unreadCounts,
  mentionCounts,
  canManageChannels,
  renderVoiceChannel,
  onSelectChannel,
  onToggleClips,
  onCreateChannel,
}: ChannelSidebarProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: categories = [] } = useListCategories(serverId);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => loadCollapsed(serverId));
  const [collapsedServer, setCollapsedServer] = useState(serverId);
  if (collapsedServer !== serverId) {
    setCollapsedServer(serverId);
    setCollapsed(loadCollapsed(serverId));
  }

  const [editing, setEditing] = useState<ChannelWithExtras | null>(null);
  const [deleting, setDeleting] = useState<ChannelWithExtras | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<{ mode: 'create' } | { mode: 'rename'; category: Category } | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);

  const groups = useMemo(() => groupChannels(channels as ChannelWithExtras[], categories), [channels, categories]);
  const sortedCategories = useMemo(() => groups.slice(1).map(g => g.category!), [groups]);
  // Quien gestiona siempre ve la cabecera: es donde está el + para crear canales y categorías.
  const showUncategorizedHeader = canManageChannels || sortedCategories.length === 0 || groups[0].channels.length > 0;

  const channelsKey = getListChannelsQueryKey(serverId);
  const categoriesKey = getListCategoriesQueryKey(serverId);
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: channelsKey });
    void queryClient.invalidateQueries({ queryKey: categoriesKey });
    void queryClient.invalidateQueries({ queryKey: ['categories', serverId] });
  };
  const fail = (title: string) => (error: unknown) => {
    toast({ title, description: apiErrorMessage(error), variant: 'destructive' });
  };

  // ── Reordenar canales: actualización optimista con marcha atrás ──────────
  const reorderChannels = useReorderChannels();
  const applyChannelOrder = (items: ChannelReorderItem[], errorTitle: string) => {
    const previous = queryClient.getQueryData<Channel[]>(channelsKey);
    queryClient.setQueryData<Channel[]>(channelsKey, current => current?.map(channel => {
      const item = items.find(entry => entry.channelId === channel.id);
      if (!item) return channel;
      return {
        ...channel,
        position: item.position,
        ...(item.categoryId !== undefined ? { categoryId: item.categoryId } : {}),
      };
    }));
    reorderChannels.mutate({ serverId, data: items }, {
      onError: error => {
        queryClient.setQueryData(channelsKey, previous);
        fail(errorTitle)(error);
      },
      onSettled: refreshAll,
    });
  };

  const moveWithinGroup = (group: Group, channel: ChannelWithExtras, direction: -1 | 1) => {
    const ordered = [...group.channels];
    const from = ordered.findIndex(c => c.id === channel.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
    applyChannelOrder(
      ordered.map((c, position) => ({ channelId: c.id, position, categoryId: group.category?.id ?? null })),
      'No se pudo mover el canal',
    );
  };

  const moveToCategory = (channel: ChannelWithExtras, target: Category | null) => {
    const destination = groups.find(g => (g.category?.id ?? null) === (target?.id ?? null));
    const ordered = [...(destination?.channels ?? []).filter(c => c.id !== channel.id), channel];
    applyChannelOrder(
      ordered.map((c, position) => ({ channelId: c.id, position, categoryId: target?.id ?? null })),
      'No se pudo mover el canal',
    );
  };

  // ── Reordenar categorías ─────────────────────────────────────────────────
  const reorderCategories = useReorderCategories();
  const moveCategory = (category: Category, direction: -1 | 1) => {
    const ordered = [...sortedCategories];
    const from = ordered.findIndex(c => c.id === category.id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
    const items = ordered.map((c, position) => ({ categoryId: c.id, position }));
    const previous = queryClient.getQueryData<Category[]>(categoriesKey);
    queryClient.setQueryData<Category[]>(categoriesKey, current => current?.map(c => {
      const item = items.find(entry => entry.categoryId === c.id);
      return item ? { ...c, position: item.position } : c;
    }));
    reorderCategories.mutate({ serverId, data: items }, {
      onError: error => {
        queryClient.setQueryData(categoriesKey, previous);
        fail('No se pudo mover la categoría')(error);
      },
      onSettled: refreshAll,
    });
  };

  const toggleCollapsed = (categoryId: number) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId); else next.add(categoryId);
      saveCollapsed(serverId, next);
      return next;
    });
  };

  // ── Menús: las mismas opciones con clic derecho y con el botón ⋮ ──────────
  const channelMenuItems = (group: Group, channel: ChannelWithExtras, kit: MenuKit) => {
    const index = group.channels.findIndex(c => c.id === channel.id);
    const currentCategoryId = channel.categoryId ?? null;
    return (
      <>
        <kit.Item onSelect={() => setEditing(channel)}>
          <Pencil className="mr-2 h-4 w-4" aria-hidden="true" /> Editar canal
        </kit.Item>
        <kit.Sub>
          <kit.SubTrigger>
            <FolderInput className="mr-2 h-4 w-4" aria-hidden="true" /> Mover a
          </kit.SubTrigger>
          <kit.SubContent>
            <kit.Item disabled={currentCategoryId === null} onSelect={() => moveToCategory(channel, null)}>
              Sin categoría
            </kit.Item>
            {sortedCategories.map(category => (
              <kit.Item
                key={category.id}
                disabled={currentCategoryId === category.id}
                onSelect={() => moveToCategory(channel, category)}
              >
                {category.name}
              </kit.Item>
            ))}
          </kit.SubContent>
        </kit.Sub>
        <kit.Item disabled={index <= 0} onSelect={() => moveWithinGroup(group, channel, -1)}>
          <ArrowUp className="mr-2 h-4 w-4" aria-hidden="true" /> Subir
        </kit.Item>
        <kit.Item disabled={index >= group.channels.length - 1} onSelect={() => moveWithinGroup(group, channel, 1)}>
          <ArrowDown className="mr-2 h-4 w-4" aria-hidden="true" /> Bajar
        </kit.Item>
        <kit.Separator />
        <kit.Item className="text-destructive focus:text-destructive" onSelect={() => setDeleting(channel)}>
          <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" /> Eliminar canal
        </kit.Item>
      </>
    );
  };

  const categoryMenuItems = (category: Category, kit: MenuKit) => {
    const index = sortedCategories.findIndex(c => c.id === category.id);
    return (
      <>
        <kit.Item onSelect={() => onCreateChannel(category.id)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Crear canal aquí
        </kit.Item>
        <kit.Item onSelect={() => setCategoryDialog({ mode: 'rename', category })}>
          <Pencil className="mr-2 h-4 w-4" aria-hidden="true" /> Renombrar categoría
        </kit.Item>
        <kit.Item disabled={index <= 0} onSelect={() => moveCategory(category, -1)}>
          <ArrowUp className="mr-2 h-4 w-4" aria-hidden="true" /> Subir
        </kit.Item>
        <kit.Item disabled={index >= sortedCategories.length - 1} onSelect={() => moveCategory(category, 1)}>
          <ArrowDown className="mr-2 h-4 w-4" aria-hidden="true" /> Bajar
        </kit.Item>
        <kit.Separator />
        <kit.Item className="text-destructive focus:text-destructive" onSelect={() => setDeletingCategory(category)}>
          <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" /> Eliminar categoría
        </kit.Item>
      </>
    );
  };

  const renderChannel = (group: Group, channel: ChannelWithExtras) => {
    const channelType = channel.channelType ?? 'text';
    const row = channelType === 'voice'
      ? renderVoiceChannel(channel, { reserveMenuSpace: canManageChannels })
      : (
        <TextChannelButton
          channel={channel}
          channelType={channelType}
          isActive={activeChannelId === channel.id && !showClips}
          unread={unreadCounts.get(channel.id) ?? 0}
          mentions={mentionCounts.get(channel.id) ?? 0}
          reserveMenuSpace={canManageChannels}
          onClick={() => onSelectChannel(channel)}
        />
      );
    if (!canManageChannels) return <div key={channel.id}>{row}</div>;
    return (
      <ContextMenu key={channel.id}>
        <ContextMenuTrigger asChild>
          <div className="group relative" data-testid={`channel-row-${channel.id}`}>
            {row}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Opciones del canal ${channel.name}`}
                  data-testid={`channel-menu-${channel.id}`}
                  className={`absolute right-0.5 top-0.5 z-20 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-white/10 hover:text-foreground [@media(hover:none)]:h-11 [@media(hover:none)]:w-11 [@media(hover:none)]:-top-1.5 ${REVEAL} ${FOCUS_RING}`}
                >
                  <MoreVertical className="h-4 w-4" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {channelMenuItems(group, channel, DROPDOWN_KIT)}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          {channelMenuItems(group, channel, CONTEXT_KIT)}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <>
      {showUncategorizedHeader && (
        <div className="group flex items-center justify-between px-2 mb-1">
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Canales</p>
          {canManageChannels && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Crear canal o categoría"
                  data-testid="sidebar-create-menu"
                  className={`rounded p-1 text-muted-foreground hover:text-foreground ${REVEAL} ${FOCUS_RING}`}
                >
                  <Plus className="w-4 h-4" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => onCreateChannel(null)}>
                  <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Crear canal
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setCategoryDialog({ mode: 'create' })}>
                  <FolderPlus className="mr-2 h-4 w-4" aria-hidden="true" /> Crear categoría
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      {groups[0].channels.map(channel => renderChannel(groups[0], channel))}

      {groups.slice(1).map(group => {
        const category = group.category!;
        const isCollapsed = collapsed.has(category.id);
        const header = (
          <div className="group relative mt-3 flex items-center pr-1" data-testid={`category-row-${category.id}`}>
            <button
              type="button"
              onClick={() => toggleCollapsed(category.id)}
              aria-expanded={!isCollapsed}
              className={`flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground ${FOCUS_RING}`}
            >
              {isCollapsed
                ? <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                : <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
              <span className="truncate">{category.name}</span>
            </button>
            {canManageChannels && (
              <>
                <button
                  type="button"
                  onClick={() => onCreateChannel(category.id)}
                  aria-label={`Crear canal en ${category.name}`}
                  className={`rounded p-1 text-muted-foreground hover:text-foreground ${REVEAL} ${FOCUS_RING}`}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Opciones de la categoría ${category.name}`}
                      data-testid={`category-menu-${category.id}`}
                      className={`rounded p-1 text-muted-foreground hover:text-foreground ${REVEAL} ${FOCUS_RING}`}
                    >
                      <MoreVertical className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {categoryMenuItems(category, DROPDOWN_KIT)}
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        );
        return (
          <div key={`category-${category.id}`} className="space-y-1">
            {canManageChannels ? (
              <ContextMenu>
                <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
                <ContextMenuContent className="w-52">{categoryMenuItems(category, CONTEXT_KIT)}</ContextMenuContent>
              </ContextMenu>
            ) : header}
            {!isCollapsed && group.channels.map(channel => renderChannel(group, channel))}
            {!isCollapsed && group.channels.length === 0 && (
              <p className="px-3 py-1 text-xs italic text-muted-foreground/70">Sin canales</p>
            )}
          </div>
        );
      })}

      {/* Clips no es un canal: acceso fijo, separado de la lista. */}
      <div className="mt-3 border-t border-white/5 pt-2">
        <button
          type="button"
          onClick={onToggleClips}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${FOCUS_RING} ${showClips ? 'bg-primary/15 text-foreground font-medium glow-effect' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}
        >
          <Play className="w-4 h-4 opacity-60 flex-shrink-0" aria-hidden="true" />
          <span>Clips</span>
        </button>
      </div>

      <EditChannelDialog
        serverId={serverId}
        channel={editing}
        categories={sortedCategories}
        onClose={() => setEditing(null)}
        onSaved={refreshAll}
      />
      <DeleteChannelDialog
        channel={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={refreshAll}
      />
      <CategoryNameDialog
        serverId={serverId}
        state={categoryDialog}
        onClose={() => setCategoryDialog(null)}
        onSaved={refreshAll}
      />
      <DeleteCategoryDialog
        category={deletingCategory}
        channelCount={deletingCategory ? groups.find(g => g.category?.id === deletingCategory.id)?.channels.length ?? 0 : 0}
        onClose={() => setDeletingCategory(null)}
        onDeleted={refreshAll}
      />
    </>
  );
}

// ── Botón de canal de texto, media o calendario ────────────────────────────
function TextChannelButton({
  channel,
  channelType,
  isActive,
  unread,
  mentions,
  reserveMenuSpace,
  onClick,
}: {
  channel: ChannelWithExtras;
  channelType: string;
  isActive: boolean;
  unread: number;
  mentions: number;
  reserveMenuSpace: boolean;
  onClick: () => void;
}) {
  const ChannelIcon = CHANNEL_TYPE_ICON[channelType as keyof typeof CHANNEL_TYPE_ICON] ?? Hash;
  const vc = channel.visualConfig ?? {};
  const hasVisual = Boolean(vc.kind && vc.value);
  const [from, to] = (vc.value ?? '').split(',');
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`channel-item-${channel.id}`}
      aria-label={`${CHANNEL_TYPE_LABEL[channelType as keyof typeof CHANNEL_TYPE_LABEL] ?? 'Canal'}: ${channel.name}`}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors relative overflow-hidden ${FOCUS_RING} ${reserveMenuSpace ? 'pr-9' : ''} ${isActive ? 'bg-primary/15 text-foreground font-medium glow-effect' : unread || mentions ? 'bg-primary/5 text-foreground font-semibold hover:bg-primary/10' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}
      style={hasVisual && vc.kind === 'gradient'
        ? { background: `linear-gradient(90deg, ${from}, ${to ?? from})`, color: 'white' }
        : hasVisual && vc.kind === 'image'
        ? { backgroundImage: `url(${vc.value})`, backgroundSize: 'cover', backgroundPosition: 'center', color: 'white' }
        : {}}
    >
      {hasVisual && <div className="absolute inset-0 bg-black/30 rounded-md" />}
      <ChannelIcon className="w-4 h-4 opacity-60 flex-shrink-0 relative z-10" aria-hidden="true" />
      <span className={`truncate relative z-10 ${unread > 0 ? 'font-semibold text-foreground' : ''}`}>{channel.name}</span>
      <span className="ml-auto flex items-center gap-1 relative z-10">
        {(channel.restrictedRoles?.length ?? 0) > 0 && (
          <span className="text-[10px] text-primary/60 font-mono" aria-label="Canal restringido">🔒</span>
        )}
        {unread > 0 && (
          <span className="min-w-[16px] h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {unread > 99 ? '99+' : unread}
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
}

// ── El mismo menú sirve para clic derecho y para el botón ⋮ ──────────────────
interface MenuKit {
  Item: typeof DropdownMenuItem;
  Separator: typeof DropdownMenuSeparator;
  Sub: typeof DropdownMenuSub;
  SubTrigger: typeof DropdownMenuSubTrigger;
  SubContent: typeof DropdownMenuSubContent;
}
const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};
const CONTEXT_KIT = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
} as unknown as MenuKit;
