import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Search, X } from "lucide-react";
import { isTrustedGiphyMediaUrl, type GiphySelection } from "@/lib/giphy";

interface GiphyResult extends GiphySelection {
  id: string;
}

interface GiphyPage {
  data: GiphyResult[];
  nextOffset: number;
  hasMore: boolean;
}

interface GiphyAvailability {
  available: boolean;
  message?: string;
}

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

async function readError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return typeof body.error === "string" ? body.error : fallback;
}

export function GifPicker({
  onSelect,
  onClose,
}: {
  onSelect: (gif: GiphySelection) => void;
  onClose: () => void;
}) {
  const [availability, setAvailability] = useState<GiphyAvailability | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [items, setItems] = useState<GiphyResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const nextOffsetRef = useRef(0);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    return () => {
      abortRef.current?.abort();
      if (restoreFocusRef.current && previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${BASE_URL}/api/giphy/status`, { credentials: "include", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await readError(response, "No se pudo consultar la disponibilidad de GIPHY."));
        return response.json() as Promise<GiphyAvailability>;
      })
      .then(setAvailability)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAvailabilityError(error instanceof Error ? error.message : "No se pudo consultar la disponibilidad de GIPHY.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), search ? 300 : 0);
    return () => window.clearTimeout(timeout);
  }, [search]);

  const loadPage = useCallback(async (append: boolean, query: string) => {
    if (!availability?.available || loadingRef.current) return;
    loadingRef.current = true;
    const requestId = ++requestIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setSearchError(null);

    const offset = append ? nextOffsetRef.current : 0;
    const params = new URLSearchParams({ offset: String(offset) });
    if (query) params.set("q", query);
    try {
      const response = await fetch(`${BASE_URL}/api/giphy/search?${params}`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await readError(response, "No se pudieron cargar los GIF."));
      const page = await response.json() as GiphyPage;
      if (requestId !== requestIdRef.current) return;
      const safeItems = Array.isArray(page.data) ? page.data.filter(item => (
        typeof item.id === "string" && isTrustedGiphyMediaUrl(item.url) && typeof item.title === "string"
      )) : [];
      setItems(previous => append ? [...previous, ...safeItems] : safeItems);
      nextOffsetRef.current = page.nextOffset;
      setHasMore(page.hasMore && safeItems.length > 0);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId === requestIdRef.current) {
        setSearchError(error instanceof Error ? error.message : "No se pudieron cargar los GIF.");
      }
    } finally {
      if (requestId === requestIdRef.current) {
        loadingRef.current = false;
        setIsLoading(false);
      }
    }
  }, [availability]);

  useEffect(() => {
    if (!availability?.available) return;
    requestIdRef.current += 1;
    abortRef.current?.abort();
    loadingRef.current = false;
    setItems([]);
    setHasMore(false);
    setSearchError(null);
    nextOffsetRef.current = 0;
    void loadPage(false, debouncedSearch);
  }, [availability?.available, debouncedSearch, loadPage]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore || !availability?.available) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        void loadPage(true, debouncedSearch);
      }
    }, { root, rootMargin: "160px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [availability?.available, debouncedSearch, hasMore, loadPage]);

  useEffect(() => {
    const updatePosition = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const height = Math.min(420, window.innerHeight - 16);
      const width = Math.min(360, window.innerWidth - 16);
      const top = rect.top >= height + 16
        ? rect.top - height - 8
        : Math.min(rect.bottom + 8, window.innerHeight - height - 8);
      setPosition({
        top: Math.max(8, top),
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, []);

  useEffect(() => {
    function handleOutside(event: MouseEvent) {
      if (pickerRef.current?.contains(event.target as Node) || anchorRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      restoreFocusRef.current = true;
      onClose();
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEscape, true);
    };
  }, [onClose]);

  const picker = (
    <div
      ref={pickerRef}
      role="dialog"
      aria-label="Selector de GIF de GIPHY"
      className="fixed z-[70] flex h-[420px] max-h-[calc(100vh-1rem)] w-[360px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      style={position ? { top: `${position.top}px`, left: `${position.left}px` } : { opacity: 0, pointerEvents: "none" }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-secondary/50 p-3">
        <label className="sr-only" htmlFor="giphy-search">Buscar GIF</label>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            id="giphy-search"
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Buscar GIF..."
            aria-label="Buscar GIF"
            className="min-w-0 flex-1 bg-transparent py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            autoFocus
          />
        </div>
        <button type="button" onClick={onClose} aria-label="Cerrar selector de GIF" title="Cerrar" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {availabilityError ? (
          <p role="alert" className="p-4 text-sm text-destructive">{availabilityError}</p>
        ) : availability === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Comprobando GIPHY…</div>
        ) : !availability.available ? (
          <div role="status" className="flex h-full flex-col items-center justify-center gap-2 p-5 text-center text-sm text-muted-foreground">
            <p>{availability.message ?? "El selector de GIF no está disponible."}</p>
          </div>
        ) : searchError ? (
          <div role="alert" className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">
            <p>{searchError}</p>
            <button type="button" onClick={() => void loadPage(false, debouncedSearch)} className="text-primary hover:underline">Reintentar</button>
          </div>
        ) : items.length === 0 && !isLoading ? (
          <p role="status" className="p-5 text-center text-sm text-muted-foreground">No se encontraron GIF.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {items.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => { onSelect({ url: item.url, title: item.title }); onClose(); }}
                title={item.title || "Seleccionar GIF"}
                aria-label={`Enviar GIF: ${item.title || "GIF de GIPHY"}`}
                className="group relative aspect-square overflow-hidden rounded-md bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <img
                  src={item.url}
                  alt={item.title || "GIF de GIPHY"}
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover transition-opacity group-hover:opacity-80"
                />
              </button>
            ))}
            <div ref={sentinelRef} aria-hidden="true" className="col-span-full h-1" />
            {isLoading && (
              <div role="status" className="col-span-full flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />Cargando más GIF…
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="shrink-0 space-y-1 border-t border-border bg-secondary/50 px-3 py-2 text-center text-[10px] text-muted-foreground">
        <a href="https://giphy.com/" target="_blank" rel="noreferrer" className="font-semibold text-foreground hover:text-primary">Powered by GIPHY</a>
        <p>Al mostrar un GIF, tu navegador se conecta a GIPHY y comparte tu dirección de red.</p>
      </footer>
    </div>
  );

  return (
    <>
      <div ref={anchorRef} className="absolute inset-0 pointer-events-none" aria-hidden="true" />
      {createPortal(picker, document.body)}
    </>
  );
}