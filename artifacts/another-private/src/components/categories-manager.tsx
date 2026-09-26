import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, GripVertical, ChevronUp, ChevronDown, Pencil, Check, X } from 'lucide-react';
import { csrfFetch } from '@workspace/api-client-react';

interface Category {
  id: number;
  name: string;
  position: number;
  serverId: number;
  createdAt: string;
}

async function fetchCategories(serverId: number): Promise<Category[]> {
  const res = await csrfFetch(`/api/servers/${serverId}/categories`);
  if (!res.ok) throw new Error('Failed to fetch categories');
  return res.json();
}

export function CategoriesManager({ serverId }: { serverId: number }) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  const { data: categories, isLoading } = useQuery({
    queryKey: ['categories', serverId],
    queryFn: () => fetchCategories(serverId),
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await csrfFetch(`/api/servers/${serverId}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Failed to create category');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories', serverId] });
      setNewName('');
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, name }: { id: number; name: string }) => {
      const res = await csrfFetch(`/api/categories/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error('Failed to update category');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories', serverId] });
      setEditingId(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await csrfFetch(`/api/categories/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete category');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories', serverId] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (items: { categoryId: number; position: number }[]) => {
      const res = await csrfFetch(`/api/servers/${serverId}/categories/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
      });
      if (!res.ok) throw new Error('Failed to reorder categories');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['categories', serverId] });
    },
  });

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  };

  const handleMove = (category: Category, direction: 'up' | 'down') => {
    if (!categories) return;
    const sorted = [...categories].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((c) => c.id === category.id);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const items = [
      { categoryId: sorted[idx].id, position: sorted[swapIdx].position },
      { categoryId: sorted[swapIdx].id, position: sorted[idx].position },
    ];
    reorderMutation.mutate(items);
  };

  const startEdit = (cat: Category) => {
    setEditingId(cat.id);
    setEditName(cat.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
  };

  const saveEdit = (id: number) => {
    const trimmed = editName.trim();
    if (!trimmed) return;
    updateMutation.mutate({ id, name: trimmed });
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-4">Cargando categorías…</div>;
  }

  const sorted = categories ? [...categories].sort((a, b) => a.position - b.position) : [];

  return (
    <div className="space-y-3">
      {/* Create new category */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          placeholder="Nueva categoría…"
          maxLength={100}
          className="flex-1 bg-background border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary/50"
        />
        <button
          onClick={handleCreate}
          disabled={!newName.trim() || createMutation.isPending}
          className="px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        >
          <Plus className="w-4 h-4" />
          Crear
        </button>
      </div>

      {/* Category list */}
      {sorted.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center border border-dashed border-white/10 rounded-lg">
          No hay categorías. Crea una para organizar tus canales.
        </div>
      ) : (
        <div className="space-y-1">
          {sorted.map((cat, idx) => (
            <div
              key={cat.id}
              className="flex items-center gap-2 px-3 py-2 bg-white/5 rounded-lg border border-white/5 group hover:border-white/10 transition-colors"
            >
              <GripVertical className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />

              {editingId === cat.id ? (
                <>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit(cat.id);
                      if (e.key === 'Escape') cancelEdit();
                    }}
                    autoFocus
                    maxLength={100}
                    className="flex-1 bg-background border border-primary/50 rounded px-2 py-1 text-sm focus:outline-none"
                  />
                  <button
                    onClick={() => saveEdit(cat.id)}
                    className="p-1 text-green-400 hover:text-green-300"
                    title="Guardar"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={cancelEdit}
                    className="p-1 text-muted-foreground hover:text-foreground"
                    title="Cancelar"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm font-medium truncate">{cat.name}</span>

                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleMove(cat, 'up')}
                      disabled={idx === 0}
                      className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title="Mover arriba"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleMove(cat, 'down')}
                      disabled={idx === sorted.length - 1}
                      className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      title="Mover abajo"
                    >
                      <ChevronDown className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => startEdit(cat)}
                      className="p-1 text-muted-foreground hover:text-foreground"
                      title="Renombrar"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => deleteMutation.mutate(cat.id)}
                      disabled={deleteMutation.isPending}
                      className="p-1 text-muted-foreground hover:text-red-400"
                      title="Eliminar categoría"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}