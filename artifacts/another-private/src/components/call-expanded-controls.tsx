import {
  Clapperboard,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  Music2,
  PhoneOff,
  SlidersHorizontal,
  Video,
  VideoOff,
} from 'lucide-react';

export interface CallExpandedControlsProps {
  isSourcesOpen: boolean;
  onToggleSources: () => void;
  isMuted: boolean;
  onToggleMute: () => void;
  isCameraOn: boolean;
  onToggleCamera: () => void;
  isScreenShareStarting: boolean;
  isScreenSharing: boolean;
  onToggleScreenShare: () => void;
  screenShareNotice: string | null;
  isSoundboardOpen: boolean;
  onToggleSoundboard: () => void;
  isWatching: boolean;
  hasWatchInvitation: boolean;
  onToggleWatch: () => void;
  onHangUp: () => void;
  onMinimize: () => void;
}

export function CallExpandedControls({
  isSourcesOpen,
  onToggleSources,
  isMuted,
  onToggleMute,
  isCameraOn,
  onToggleCamera,
  isScreenShareStarting,
  isScreenSharing,
  onToggleScreenShare,
  screenShareNotice,
  isSoundboardOpen,
  onToggleSoundboard,
  isWatching,
  hasWatchInvitation,
  onToggleWatch,
  onHangUp,
  onMinimize,
}: CallExpandedControlsProps) {
  return (
    <div className="flex w-full flex-shrink-0 items-start justify-between gap-2 border-t border-white/10 bg-card/80 px-2 py-2 backdrop-blur-md sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onToggleSources}
          aria-label="Controles de participantes y fuentes"
          aria-expanded={isSourcesOpen}
          className={`flex h-11 items-center gap-1 rounded-full px-3 transition-colors ${isSourcesOpen ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground hover:bg-primary/10'}`}
          title="Ajustar voz, cámara y pantalla por participante"
        >
          <SlidersHorizontal className="h-5 w-5" aria-hidden="true" />
          <span className="text-xs">Fuentes</span>
        </button>
        <button
          type="button"
          onClick={onToggleMute}
          aria-label={isMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors ${isMuted ? 'bg-red-500 text-white' : 'bg-secondary text-foreground hover:bg-white/10'}`}
          title={isMuted ? 'Activar micrófono' : 'Silenciar'}
        >
          {isMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={onToggleCamera}
          aria-label={isCameraOn ? 'Apagar cámara' : 'Encender cámara'}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors ${isCameraOn ? 'bg-secondary text-foreground hover:bg-white/10' : 'bg-secondary text-muted-foreground hover:bg-white/10'}`}
          title={isCameraOn ? 'Apagar cámara' : 'Encender cámara'}
        >
          {isCameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={onToggleScreenShare}
          disabled={isScreenShareStarting}
          aria-pressed={isScreenSharing}
          aria-label={isScreenSharing ? 'Dejar de compartir pantalla' : 'Compartir pantalla'}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-50 ${isScreenSharing ? 'bg-primary text-primary-foreground glow-effect ring-2 ring-primary/50' : 'bg-secondary text-foreground hover:bg-primary/10'}`}
          title={isScreenSharing ? 'Dejar de compartir pantalla' : 'Compartir pantalla'}
        >
          {isScreenSharing ? <MonitorOff className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={onToggleSoundboard}
          aria-label="Abrir soundboard"
          aria-pressed={isSoundboardOpen}
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors ${isSoundboardOpen ? 'bg-primary text-primary-foreground glow-effect' : 'bg-secondary text-foreground hover:bg-primary/10'}`}
          title="Soundboard"
        >
          <Music2 className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={onToggleWatch}
          aria-label={hasWatchInvitation
            ? 'Invitación a visionado conjunto; abrir para unirte'
            : 'Abrir visionado conjunto'}
          aria-pressed={isWatching}
          className={`relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors ${isWatching ? 'bg-primary text-primary-foreground glow-effect' : 'bg-secondary text-foreground hover:bg-primary/10'}`}
          title="Ver y escuchar juntos"
        >
          <Clapperboard className="h-5 w-5" />
          {hasWatchInvitation && (
            <span className="absolute -top-2 -right-1 rounded-full bg-primary px-1.5 py-0.5 text-[8px] font-bold text-primary-foreground">
              Invitación
            </span>
          )}
        </button>
        {screenShareNotice && (
          <span role="status" className="basis-full px-2 text-center text-xs text-muted-foreground">
            {screenShareNotice}
          </span>
        )}
      </div>
      <div className="flex flex-shrink-0 self-start items-center gap-1.5 border-l border-border/60 pl-2" aria-label="Controles críticos de llamada">
        <button
          type="button"
          onClick={onHangUp}
          aria-label="Colgar llamada"
          data-testid="button-hang-up"
          className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600"
          title="Colgar"
        >
          <PhoneOff className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Minimizar llamada"
          data-testid="button-minimize-call"
          className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-secondary text-foreground transition-colors hover:bg-white/10"
          title="Minimizar llamada"
        >
          <Minimize2 className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}