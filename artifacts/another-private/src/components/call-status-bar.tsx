import { Maximize2, Mic, MicOff, Music2, PhoneOff, Clapperboard, SlidersHorizontal } from 'lucide-react';

interface CallStatusBarProps {
  name: string;
  status: string;
  participants: string;
  isMuted: boolean;
  isMinimized: boolean;
  onToggleMute: () => void;
  onHangUp: () => void;
  onExpand: () => void;
  onOpenSoundboard: () => void;
  onOpenWatch: () => void;
  isWatching: boolean;
  hasWatchInvitation: boolean;
  onOpenSources: () => void;
  isSourcesOpen: boolean;
}

export function CallStatusBar({
  name, status, participants, isMuted, isMinimized, onToggleMute, onHangUp, onExpand,
  onOpenSoundboard, onOpenWatch, isWatching, hasWatchInvitation, onOpenSources, isSourcesOpen,
}: CallStatusBarProps) {
  return (
    <div className="w-full min-w-0 shrink-0 border-t border-border bg-card px-2 py-2" data-testid="compact-call-controls">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0" title={participants}>
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-primary">{name}</p>
            <p className="truncate font-mono text-[10px] text-muted-foreground">{status} · {participants}</p>
          </div>
        </div>
        {/* Keep both emergency actions outside the wrapping row, anchored top-right. */}
        <div className="flex shrink-0 items-center gap-1" aria-label="Acciones principales de la llamada">
          {isMinimized && (
            <button
              type="button"
              onClick={onExpand}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              title="Expandir llamada"
              aria-label="Expandir llamada"
            >
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onHangUp}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-destructive text-destructive-foreground transition-colors hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
            title="Colgar"
            aria-label="Colgar"
          >
            <PhoneOff className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5" aria-label="Controles secundarios de la llamada">
        <button
          type="button"
          onClick={onToggleMute}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${isMuted ? 'bg-destructive text-destructive-foreground' : 'text-primary hover:bg-primary/15'}`}
          title={isMuted ? 'Activar micrófono' : 'Silenciar'}
          aria-label={isMuted ? 'Activar micrófono' : 'Silenciar'}
        >
          {isMuted ? <MicOff className="h-4 w-4" aria-hidden="true" /> : <Mic className="h-4 w-4" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={onOpenSoundboard}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          title="Abrir soundboard"
          aria-label="Abrir soundboard"
        >
          <Music2 className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onOpenSources}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${isSourcesOpen ? 'bg-primary/15 text-primary' : 'text-primary hover:bg-primary/15'}`}
          title="Controlar voz, cámara y pantalla de cada participante"
          aria-label="Controles de participantes y fuentes"
          aria-expanded={isSourcesOpen}
        >
          <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onOpenWatch}
          className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${isWatching ? 'bg-primary/15 text-primary' : 'text-primary hover:bg-primary/15'}`}
          title={hasWatchInvitation ? 'Hay un visionado en curso; abre la invitación para ver los detalles y unirte' : 'Abrir visionado conjunto'}
          aria-label={hasWatchInvitation ? 'Ver la invitación a visionado conjunto' : 'Abrir visionado conjunto'}
          aria-pressed={isWatching}
        >
          <Clapperboard className="h-4 w-4" aria-hidden="true" />
          {hasWatchInvitation && (
            <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}