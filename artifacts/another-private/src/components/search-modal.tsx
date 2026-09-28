import { useState, useEffect, useRef } from 'react';
import { Search, X, Hash, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { sameOriginUploadUrl } from '@/lib/media-url';

interface SearchResult {
  id: number;
  channelId?: number;
  channelName?: string;
  userId: number;
  content: string;
  createdAt: string;
  author: { username: string; displayName: string; avatarUrl?: string | null };
}

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId?: number | null;
  channelId?: number | null;
  dmUserId?: number | null;
  onJumpToMessage?: (channelId: number, messageId: number) => void;
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

export function SearchModal({ isOpen, onClose, serverId, channelId, dmUserId, onJumpToMessage }: SearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery(''); setResults([]); setSearched(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim() || query.trim().length < 2) { setResults([]); setSearched(false); return; }
    debounceRef.current = setTimeout(() => doSearch(query.trim()), 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  const doSearch = async (q: string) => {
    setLoading(true);
    try {
      let url = '';
      if (channelId) url = `${BASE}/api/channels/${channelId}/search?q=${encodeURIComponent(q)}`;
      else if (serverId) url = `${BASE}/api/servers/${serverId}/search?q=${encodeURIComponent(q)}`;
      else if (dmUserId) url = `${BASE}/api/dms/${dmUserId}/search?q=${encodeURIComponent(q)}`;
      else return;
      const res = await fetch(url, { credentials: 'include' });
      if (res.ok) setResults(await res.json());
    } catch {}
    setLoading(false);
    setSearched(true);
  };

  if (!isOpen) return null;

  const highlightMatch = (text: string, q: string) => {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-yellow-400/30 text-yellow-200 rounded">{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-16 px-4" onClick={onClose}>
      <div className="w-full max-w-2xl bg-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
          <Search className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={channelId ? 'Buscar en este canal…' : serverId ? 'Buscar en el servidor…' : 'Buscar mensajes…'}
            className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none text-sm"
          />
          {query && (
            <button onClick={() => { setQuery(''); setResults([]); }} className="p-1 text-muted-foreground hover:text-white rounded">
              <X className="w-4 h-4" />
            </button>
          )}
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-white rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm font-mono">
              Buscando…
            </div>
          )}
          {!loading && searched && results.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
              <Search className="w-10 h-10 opacity-20" />
              <p className="text-sm font-mono">Sin resultados para "{query}"</p>
            </div>
          )}
          {!loading && results.length > 0 && (
            <div className="divide-y divide-white/5">
              {results.map(r => (
                <div
                  key={r.id}
                  className="px-4 py-3 hover:bg-white/5 transition-colors group cursor-pointer"
                  onClick={() => { if (r.channelId && onJumpToMessage) onJumpToMessage(r.channelId, r.id); }}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden flex-shrink-0 mt-0.5">
                      {r.author.avatarUrl && <img src={sameOriginUploadUrl(r.author.avatarUrl)} className="w-full h-full object-cover" alt="" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-foreground">{r.author.displayName}</span>
                        {r.channelName && (
                          <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                            <Hash className="w-3 h-3" />{r.channelName}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground ml-auto">
                          {format(new Date(r.createdAt), "d MMM yyyy HH:mm", { locale: es })}
                        </span>
                      </div>
                      <p className="text-sm text-foreground/80 line-clamp-2">
                        {highlightMatch(r.content, query.trim())}
                      </p>
                    </div>
                    {r.channelId && onJumpToMessage && (
                      <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-1" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!searched && !loading && (
            <div className="py-8 px-4 text-center text-muted-foreground text-sm">
              Escribe al menos 2 caracteres para buscar
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
