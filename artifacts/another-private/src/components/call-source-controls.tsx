import React from 'react';
import { 
  X, Mic, MicOff, Video, VideoOff, 
  Monitor, MonitorOff, Volume2, VolumeX, Info 
} from 'lucide-react';
import type { 
  CallAudioSource, 
  CallVideoSource, 
  PeerSourcePreferences, 
  SourceLevel 
} from '@/lib/call-source-preferences';

export interface CallSourceControlsProps {
  participants: Array<{
    userId: number;
    displayName: string;
    hasMicrophone: boolean;
    hasCamera: boolean;
    hasScreen: boolean;
    hasScreenAudio: boolean;
    preferences: Readonly<PeerSourcePreferences>;
  }>;
  onAudioChange: (peerId: number, source: CallAudioSource, patch: Partial<SourceLevel>) => void;
  onToggleVideo: (peerId: number, source: CallVideoSource) => void;
  onClose: () => void;
}

export function CallSourceControls({
  participants,
  onAudioChange,
  onToggleVideo,
  onClose
}: CallSourceControlsProps) {
  return (
    <div className="flex flex-col w-full max-w-sm bg-card/95 backdrop-blur-md border border-border shadow-xl rounded-xl overflow-hidden pointer-events-auto">
      <div className="px-4 py-3 flex items-center justify-between border-b border-border bg-secondary/30">
        <h3 className="font-semibold text-sm text-foreground">Ajustes de participantes</h3>
        <button 
          onClick={onClose}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
          aria-label="Cerrar ajustes"
          data-testid="button-close-source-controls"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      
      <div className="px-4 py-2.5 flex items-start gap-2.5 bg-primary/5 border-b border-primary/10">
        <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Estos ajustes son <strong className="text-foreground font-medium">locales</strong>. Solo te afectan a ti y no cambiarán lo que ven o escuchan los demás.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto max-h-[400px] p-3 space-y-3">
        {participants.length === 0 ? (
          <div className="text-center p-6 text-xs text-muted-foreground bg-secondary/20 rounded-lg border border-dashed border-border">
            No hay otros participantes.
          </div>
        ) : (
          participants.map(p => (
            <ParticipantControls 
              key={p.userId} 
              participant={p} 
              onAudioChange={onAudioChange} 
              onToggleVideo={onToggleVideo} 
            />
          ))
        )}
      </div>
    </div>
  );
}

function ParticipantControls({ 
  participant, 
  onAudioChange, 
  onToggleVideo 
}: { 
  participant: CallSourceControlsProps['participants'][0];
  onAudioChange: CallSourceControlsProps['onAudioChange'];
  onToggleVideo: CallSourceControlsProps['onToggleVideo'];
}) {
  const p = participant;
  const prefs = p.preferences;

  return (
    <div className="p-3.5 bg-secondary/10 rounded-lg border border-border space-y-4">
      <div className="font-medium text-sm text-foreground flex items-center justify-between">
        <span className="truncate pr-2" title={p.displayName}>{p.displayName}</span>
      </div>

      <div className="space-y-3">
        {/* Microphone */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Micrófono</span>
            <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right font-medium">
              {Math.round(prefs.microphone.volume * 100)}%
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => onAudioChange(p.userId, 'microphone', { muted: !prefs.microphone.muted })}
              className={`p-1.5 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                prefs.microphone.muted || !p.hasMicrophone
                  ? 'text-destructive bg-destructive/10 hover:bg-destructive/20'
                  : 'text-primary bg-primary/10 hover:bg-primary/20'
              }`}
              disabled={!p.hasMicrophone}
              aria-label={prefs.microphone.muted ? `Activar micrófono de ${p.displayName}` : `Silenciar micrófono de ${p.displayName}`}
              title={!p.hasMicrophone ? 'Sin micrófono' : prefs.microphone.muted ? 'Activar' : 'Silenciar'}
              data-testid={`button-mute-microphone-${p.userId}`}
            >
              {prefs.microphone.muted || !p.hasMicrophone ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={Math.round(prefs.microphone.volume * 100)}
              onChange={(e) => onAudioChange(p.userId, 'microphone', { volume: parseInt(e.target.value, 10) / 100 })}
              disabled={!p.hasMicrophone || prefs.microphone.muted}
              className="flex-1 h-1.5 bg-secondary/50 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={`Volumen del micrófono de ${p.displayName}`}
              data-testid={`slider-volume-microphone-${p.userId}`}
            />
          </div>
        </div>

        {/* Camera */}
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground font-medium">Cámara</span>
          <button
            onClick={() => onToggleVideo(p.userId, 'camera')}
            disabled={!p.hasCamera}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
              !prefs.cameraVisible || !p.hasCamera
                ? 'text-muted-foreground bg-secondary/50 hover:bg-secondary'
                : 'text-primary bg-primary/10 hover:bg-primary/20'
            }`}
            aria-label={prefs.cameraVisible ? `Ocultar cámara de ${p.displayName}` : `Mostrar cámara de ${p.displayName}`}
            title={!p.hasCamera ? 'Sin cámara' : prefs.cameraVisible ? 'Ocultar' : 'Mostrar'}
            data-testid={`button-toggle-camera-${p.userId}`}
          >
            {!prefs.cameraVisible || !p.hasCamera ? <VideoOff className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
            {prefs.cameraVisible ? 'Visible' : 'Oculta'}
          </button>
        </div>

        {/* Screen */}
        {p.hasScreen && (
          <div className="flex items-center justify-between pt-2 border-t border-border/50">
            <span className="text-xs text-muted-foreground font-medium">Pantalla compartida</span>
            <button
              onClick={() => onToggleVideo(p.userId, 'screen')}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                !prefs.screenVisible
                  ? 'text-muted-foreground bg-secondary/50 hover:bg-secondary'
                  : 'text-primary bg-primary/10 hover:bg-primary/20'
              }`}
              aria-label={prefs.screenVisible ? `Ocultar pantalla de ${p.displayName}` : `Mostrar pantalla de ${p.displayName}`}
              data-testid={`button-toggle-screen-${p.userId}`}
            >
              {!prefs.screenVisible ? <MonitorOff className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}
              {prefs.screenVisible ? 'Visible' : 'Oculta'}
            </button>
          </div>
        )}

        {/* Screen Audio */}
        {p.hasScreen && p.hasScreenAudio && (
          <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">Audio de la pantalla</span>
              <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right font-medium">
                {Math.round(prefs.screen.volume * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => onAudioChange(p.userId, 'screen', { muted: !prefs.screen.muted })}
                className={`p-1.5 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${
                  prefs.screen.muted
                    ? 'text-destructive bg-destructive/10 hover:bg-destructive/20'
                    : 'text-primary bg-primary/10 hover:bg-primary/20'
                }`}
                aria-label={prefs.screen.muted ? `Activar audio de pantalla de ${p.displayName}` : `Silenciar audio de pantalla de ${p.displayName}`}
                data-testid={`button-mute-screen-${p.userId}`}
              >
                {prefs.screen.muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={Math.round(prefs.screen.volume * 100)}
                onChange={(e) => onAudioChange(p.userId, 'screen', { volume: parseInt(e.target.value, 10) / 100 })}
                disabled={prefs.screen.muted}
                className="flex-1 h-1.5 bg-secondary/50 rounded-full appearance-none cursor-pointer accent-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={`Volumen de pantalla de ${p.displayName}`}
                data-testid={`slider-volume-screen-${p.userId}`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
