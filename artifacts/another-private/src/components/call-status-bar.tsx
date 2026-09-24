import { Maximize2, Mic, MicOff, Music2, PhoneOff, Volume2 } from 'lucide-react';

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
}

export function CallStatusBar({
  name, status, participants, isMuted, isMinimized, onToggleMute, onHangUp, onExpand, onOpenSoundboard,
}: CallStatusBarProps) {
  return (
    <div className="bg-green-950/60 border-t border-green-500/20 px-3 py-2 flex items-center gap-2">
      <Volume2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
      <div className="flex-1 min-w-0" title={participants}>
        <p className="text-xs text-green-400 font-medium truncate">{name}</p>
        <p className="text-[10px] text-green-400 font-mono truncate">{status} · {participants}</p>
      </div>
      <button
        type="button"
        onClick={onOpenSoundboard}
        className="p-1 text-primary hover:bg-primary/15 rounded transition-colors"
        title="Abrir soundboard"
        aria-label="Abrir soundboard"
      >
        <Music2 className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onToggleMute}
        className={`p-1 rounded transition-colors ${isMuted ? 'text-red-400 bg-red-500/20' : 'text-green-400 hover:bg-green-500/20'}`}
        title={isMuted ? 'Activar micrófono' : 'Silenciar'}
        aria-label={isMuted ? 'Activar micrófono' : 'Silenciar'}
      >
        {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
      </button>
      {isMinimized && (
        <button
          type="button"
          onClick={onExpand}
          className="p-1 text-green-400 hover:bg-green-500/20 rounded transition-colors"
          title="Expandir llamada"
          aria-label="Expandir llamada"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        type="button"
        onClick={onHangUp}
        className="p-1 text-red-400 hover:bg-red-500/20 rounded transition-colors"
        title="Desconectar"
        aria-label="Desconectar"
      >
        <PhoneOff className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}