import React, { useState, useEffect, useRef } from 'react';
import { 
  Play, Pause, SkipForward, X, Volume2, VolumeX, Shield, Users, 
  AlertCircle, MonitorPlay, Info, ChevronUp, ChevronDown, Plus, 
  Power, Link as LinkIcon
} from 'lucide-react';

export interface WatchItem {
  id: string;
  platform: 'youtube' | 'soundcloud';
  contentId: string;
  canonicalUrl: string;
  addedById: number;
  addedByName: string;
  title: string;
  durationMs?: number;
}

export interface WatchSession {
  controllerUserId: number;
  allowEveryone: boolean;
  current: WatchItem | null;
  queue: WatchItem[];
  playing: boolean;
  positionMs: number;
  updatedAtMs: number;
  serverNowMs: number;
  revision: number;
}

export interface WatchPanelProps {
  session: WatchSession | null;
  localVolume: number;
  onLocalVolumeChange: (volume: number) => void;
  canControl: boolean;
  onStart: (url: string) => void;
  onAdd: (url: string) => void;
  onAction: (action: "play" | "pause" | "seek" | "skip" | "reorder" | "remove" | "transfer" | "everyone" | "end" | "ended" | "metadata", payload?: any) => void;
  player: React.ReactNode;
  error: string | null;
  active: 'voice' | 'dm';
  onClose?: () => void;
  participants?: Array<{userId: number, displayName: string}>;
  currentUserId?: number;
}

export function WatchPanel({
  session,
  localVolume,
  onLocalVolumeChange,
  canControl,
  onStart,
  onAdd,
  onAction,
  player,
  error,
  active,
  onClose,
  participants,
  currentUserId
}: WatchPanelProps) {
  const [startUrl, setStartUrl] = useState('');
  const [addUrl, setAddUrl] = useState('');

  const [showWarning, setShowWarning] = useState(() => {
    try {
      return localStorage.getItem('aeronight_watch_headphone_warning_seen') !== 'true';
    } catch {
      return true;
    }
  });

  const dismissWarning = () => {
    setShowWarning(false);
    try {
      localStorage.setItem('aeronight_watch_headphone_warning_seen', 'true');
    } catch (e) {}
  };

  const formatTime = (ms?: number) => {
    if (ms === undefined || isNaN(ms)) return '0:00';
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Timeline Progress State
  const offsetRef = useRef(0);
  const [seekPos, setSeekPos] = useState(0);
  const [isDraggingSeek, setIsDraggingSeek] = useState(false);

  useEffect(() => {
    if (session) {
      offsetRef.current = Date.now() - session.serverNowMs;
    }
  }, [session?.serverNowMs]);

  useEffect(() => {
    if (!session?.current) {
      setSeekPos(0);
      return;
    }
    if (isDraggingSeek) return;

    if (!session.playing) {
      setSeekPos(session.positionMs);
      return;
    }

    const updatePos = () => {
      const serverNowEstimated = Date.now() - offsetRef.current;
      const elapsed = Math.max(0, serverNowEstimated - session.updatedAtMs);
      const duration = session.current?.durationMs || 0;
      const pos = Math.min(session.positionMs + elapsed, duration > 0 ? duration : Infinity);
      setSeekPos(pos);
    };

    updatePos();
    const interval = setInterval(updatePos, 250);
    return () => clearInterval(interval);
  }, [session, isDraggingSeek]);

  if (!session) {
    return (
      <div className="flex flex-col h-full w-full bg-card/40 backdrop-blur-md border border-border rounded-xl overflow-hidden relative">
        <div className="px-3 py-2.5 flex items-center justify-between border-b border-border bg-secondary/30">
          <h3 className="font-bold text-foreground flex items-center gap-2 text-sm">
            <MonitorPlay className="w-4 h-4 text-primary" />
            Ver Juntos
          </h3>
          {onClose && (
            <button 
              onClick={onClose} 
              className="p-1 text-muted-foreground hover:text-white rounded-lg hover:bg-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
              aria-label="Cerrar panel"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 p-4 flex flex-col items-center justify-center text-center gap-4 overflow-y-auto">
           <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-1 shrink-0">
             <MonitorPlay className="w-7 h-7 text-primary" />
           </div>
           <div>
             <h4 className="font-bold text-base text-foreground">Iniciar Watch Party</h4>
             <p className="text-xs text-muted-foreground max-w-[250px] mt-1">Pega un enlace de YouTube o SoundCloud para ver y escuchar juntos.</p>
           </div>
           {error && (
             <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/10 border border-destructive/20 p-2 rounded-lg w-full max-w-sm justify-center">
               <AlertCircle className="w-3.5 h-3.5 shrink-0" />
               <span className="truncate">{error}</span>
             </div>
           )}
           <form 
             onSubmit={(e) => { e.preventDefault(); if (startUrl.trim()) onStart(startUrl.trim()); setStartUrl(''); }} 
             className="w-full max-w-sm flex gap-2 mt-2"
           >
             <div className="relative flex-1">
               <LinkIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
               <input 
                 type="text" 
                 placeholder="https://youtube.com/watch?v=..." 
                 value={startUrl}
                 onChange={e => setStartUrl(e.target.value)}
                 className="w-full bg-background border border-border rounded-lg pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary text-foreground"
                 aria-label="URL de multimedia"
               />
             </div>
             <button 
               type="submit" 
               disabled={!startUrl.trim()} 
               className="bg-primary/20 text-primary hover:bg-primary/30 border border-primary/30 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
             >
               Iniciar
             </button>
           </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-card/40 backdrop-blur-md border border-border rounded-xl overflow-hidden relative">
      <div className="px-3 py-2 flex items-center justify-between border-b border-border bg-secondary/30 shrink-0">
        <h3 className="font-bold text-foreground flex items-center gap-2 text-sm">
          <MonitorPlay className="w-4 h-4 text-primary" />
          Ver Juntos
        </h3>
        <div className="flex items-center gap-1">
          {canControl && (
            <>
              {currentUserId === session.controllerUserId && participants && participants.length > 1 && (
                <select
                  className="bg-transparent text-muted-foreground hover:text-white text-xs border border-transparent hover:border-border rounded cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary h-7 max-w-[120px] px-1 mr-1"
                  onChange={(e) => {
                    if (e.target.value) {
                      onAction('transfer', { userId: Number(e.target.value) });
                      e.target.value = "";
                    }
                  }}
                  aria-label="Transferir control del anfitrión"
                  title="Transferir control"
                  defaultValue=""
                >
                  <option value="" disabled hidden>Transferir...</option>
                  {participants.filter(p => p.userId !== currentUserId).map(p => (
                    <option key={p.userId} value={p.userId} className="bg-secondary text-foreground">
                      {p.displayName}
                    </option>
                  ))}
                </select>
              )}
              
              <button 
                onClick={() => onAction('everyone', { allowEveryone: !session.allowEveryone })}
                className={`p-1.5 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${session.allowEveryone ? 'bg-primary/20 text-primary hover:bg-primary/30' : 'text-muted-foreground hover:bg-white/10 hover:text-white'}`}
                title={session.allowEveryone ? "Todos pueden controlar" : "Solo el anfitrión puede controlar"}
                aria-label="Alternar todos pueden controlar"
              >
                {session.allowEveryone ? <Users className="w-3.5 h-3.5" /> : <Shield className="w-3.5 h-3.5" />}
              </button>
              
              <div className="w-px h-3.5 bg-border mx-1" />
              
              <button 
                onClick={() => onAction('end')}
                className="p-1.5 text-destructive hover:bg-destructive/20 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-destructive"
                title="Terminar Watch Party"
                aria-label="Terminar Watch Party"
              >
                <Power className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto relative">
        {(showWarning || error) && (
          <div className="p-3 pb-0 space-y-2">
            {showWarning && (
              <div className="bg-primary/10 border border-primary/30 p-2.5 rounded-lg flex items-start gap-2.5">
                <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <div className="flex-1 text-[11px] text-primary/90 leading-relaxed">
                  Para la mejor experiencia sin eco, por favor usa auriculares mientras ven juntos.
                </div>
                <button 
                  onClick={dismissWarning} 
                  className="shrink-0 p-1 hover:bg-primary/20 rounded text-primary/70 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label="Descartar aviso"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-destructive text-xs bg-destructive/10 border border-destructive/20 p-2.5 rounded-lg">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="flex-1 break-words">{error}</span>
              </div>
            )}
          </div>
        )}

        {/* Sticky Player + Controls */}
        <div className={`sticky top-0 z-20 flex flex-col gap-3 p-3 bg-background/95 backdrop-blur-md border-b border-border/50 shadow-sm ${(showWarning || error) ? 'mt-2' : ''}`}>
          {/* Player min-size area, no fixed aspect/cropping */}
          <div className="w-full min-h-[200px] min-w-[200px] bg-black/60 rounded-lg flex flex-col border border-border shadow-lg">
            {player}
            {(!session.current && !player) && (
              <div className="flex-1 min-h-[200px] flex flex-col items-center justify-center text-muted-foreground gap-2 p-4 text-center pointer-events-none">
                <MonitorPlay className="w-8 h-8 opacity-30" />
                <span className="text-xs font-medium opacity-50">Sin reproducción</span>
              </div>
            )}
          </div>

          {/* Current Info & Controls */}
          <div className="bg-secondary/20 p-2.5 rounded-lg border border-border flex flex-col gap-2">
            {session.current && (
              <div className="px-1">
                <h4 className="font-semibold text-foreground text-xs line-clamp-1" title={session.current.title || session.current.canonicalUrl}>
                  {session.current.title || session.current.canonicalUrl}
                </h4>
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                  <span>Añadido por {session.current.addedByName}</span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => onAction(session.playing ? 'pause' : 'play')} 
                  disabled={!canControl || !session.current}
                  className="w-8 h-8 flex items-center justify-center rounded-full bg-primary/20 text-primary hover:bg-primary/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label={session.playing ? 'Pausar' : 'Reproducir'}
                >
                  {session.playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                </button>
                <button 
                  onClick={() => onAction('skip')} 
                  disabled={!canControl || (!session.current && session.queue.length === 0)}
                  className="w-7 h-7 flex items-center justify-center rounded-full text-muted-foreground hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label="Saltar adelante"
                  title="Saltar"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                </button>
              </div>
              
              <div className="flex items-center gap-1.5">
                <button 
                  onClick={() => onLocalVolumeChange(localVolume === 0 ? 1 : 0)}
                  className="text-muted-foreground hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-primary rounded p-1"
                  aria-label={localVolume === 0 ? 'Activar volumen local' : 'Silenciar volumen local'}
                  title="Volumen local"
                >
                  {localVolume === 0 ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={localVolume}
                  onChange={(e) => onLocalVolumeChange(parseFloat(e.target.value))}
                  className="w-16 h-1.5 bg-secondary/80 rounded-lg appearance-none cursor-pointer accent-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label="Control de volumen"
                />
              </div>
            </div>

            {session.current && (
              <div className="flex items-center gap-2 text-[10px] w-full px-1">
                <span className="text-muted-foreground w-8 text-right tabular-nums">
                  {formatTime(seekPos)}
                </span>
                <input
                  type="range"
                  min="0"
                  max={session.current.durationMs || 100}
                  value={seekPos}
                  disabled={!canControl || !session.current.durationMs}
                  onChange={(e) => {
                    setIsDraggingSeek(true);
                    setSeekPos(Number(e.target.value));
                  }}
                  onPointerUp={(e) => {
                    setIsDraggingSeek(false);
                    if (canControl) onAction('seek', { positionMs: Number(e.currentTarget.value) });
                  }}
                  className="flex-1 h-1 bg-secondary/80 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label="Progreso de reproducción"
                />
                <span className="text-muted-foreground w-8 tabular-nums">
                  {session.current.durationMs ? formatTime(session.current.durationMs) : '∞'}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Scrollable Queue Area */}
        <div className="p-3 space-y-2">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-xs font-semibold text-foreground">Siguiente en la cola</h4>
            <span className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded-full bg-secondary/50 border border-border/50">
              {session.queue.length} / 50
            </span>
          </div>

          <form 
            onSubmit={(e) => { e.preventDefault(); if (addUrl.trim()) onAdd(addUrl.trim()); setAddUrl(''); }} 
            className="flex gap-1.5"
          >
            <input 
              type="text" 
              placeholder="Añadir enlace de YouTube o SoundCloud..." 
              value={addUrl}
              onChange={e => setAddUrl(e.target.value)}
              className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary text-foreground"
              aria-label="URL para añadir a la cola"
            />
            <button 
              type="submit" 
              disabled={!addUrl.trim() || session.queue.length >= 50} 
              className="shrink-0 bg-secondary hover:bg-secondary/80 border border-border rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <Plus className="w-3.5 h-3.5" />
              Añadir
            </button>
          </form>

          <div className="space-y-1.5 pb-1">
            {session.queue.length === 0 ? (
              <div className="text-center py-4 text-xs text-muted-foreground bg-secondary/10 rounded-lg border border-border/50 border-dashed">
                La cola está vacía
              </div>
            ) : (
              session.queue.map((item, index) => (
                <div key={`${item.id}-${index}`} className="flex items-center gap-2 p-1.5 bg-secondary/30 rounded-lg border border-border hover:bg-secondary/50 transition-colors group">
                  {canControl && (
                    <div className="flex flex-col gap-px shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={() => onAction('reorder', { itemId: item.id, toIndex: index - 1 })} 
                        disabled={index === 0}
                        className="p-0.5 hover:bg-white/10 rounded disabled:opacity-30 disabled:hover:bg-transparent text-muted-foreground hover:text-white focus:outline-none focus:ring-1 focus:ring-primary"
                        aria-label="Mover arriba"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button 
                        onClick={() => onAction('reorder', { itemId: item.id, toIndex: index + 1 })} 
                        disabled={index === session.queue.length - 1}
                        className="p-0.5 hover:bg-white/10 rounded disabled:opacity-30 disabled:hover:bg-transparent text-muted-foreground hover:text-white focus:outline-none focus:ring-1 focus:ring-primary"
                        aria-label="Mover abajo"
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  
                  <div className="flex-1 min-w-0 py-0.5 pl-1">
                    <p className="text-[11px] font-medium text-foreground truncate" title={item.title || item.canonicalUrl}>
                      {item.title || item.canonicalUrl}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <p className="text-[9px] text-muted-foreground truncate">Añadido por {item.addedByName}</p>
                      {item.durationMs && (
                        <>
                          <span className="text-[9px] text-muted-foreground/50">&middot;</span>
                          <span className="text-[9px] text-muted-foreground">{formatTime(item.durationMs)}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {canControl && (
                    <button 
                      onClick={() => onAction('remove', { itemId: item.id })}
                      className="shrink-0 p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-destructive"
                      title="Eliminar de la cola"
                      aria-label="Eliminar de la cola"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
