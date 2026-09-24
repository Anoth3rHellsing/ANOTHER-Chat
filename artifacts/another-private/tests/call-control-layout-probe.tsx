import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CallStatusBar } from '../src/components/call-status-bar';
import { CallExpandedControls } from '../src/components/call-expanded-controls';
import '../src/index.css';

declare global {
  interface Window {
    callControlProbe?: { expanded: number; hungUp: number; minimized: number };
  }
}

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'basic';
const all = scenario === 'all';
const active = (feature: string) => all || scenario.split(',').includes(feature);
const sidebarWidth = Math.max(96, Math.min(360, Number(params.get('sidebar')) || 240));

function LayoutProbe() {
  const [isMinimized, setIsMinimized] = useState(true);
  const [isMuted, setIsMuted] = useState(active('muted'));
  const [isCameraOn, setIsCameraOn] = useState(active('camera'));
  const [isScreenSharing, setIsScreenSharing] = useState(active('screen'));
  const [isWatching, setIsWatching] = useState(active('watch'));
  const [isSoundboardOpen, setIsSoundboardOpen] = useState(active('soundboard'));
  const [isSourcesOpen, setIsSourcesOpen] = useState(active('sources'));
  const [counters, setCounters] = useState({ expanded: 0, hungUp: 0, minimized: 0 });
  useEffect(() => { window.callControlProbe = counters; }, [counters]);

  const hangUp = () => setCounters(counts => ({ ...counts, hungUp: counts.hungUp + 1 }));
  const expand = () => {
    setIsMinimized(false);
    setCounters(counts => ({ ...counts, expanded: counts.expanded + 1 }));
  };
  const minimize = () => {
    setIsMinimized(true);
    setCounters(counts => ({ ...counts, minimized: counts.minimized + 1 }));
  };

  return (
    <main className="flex min-h-screen flex-col gap-6 p-4">
      <h1 className="text-sm font-semibold text-primary">Prueba aislada: {scenario} · barra lateral {sidebarWidth}px</h1>
      <section aria-label="Barra lateral de llamada minimizada" className="space-y-2">
        <h2 className="text-xs text-muted-foreground">Indicador minimizado — componente real</h2>
        <div
          id="compact-frame"
          style={{ width: sidebarWidth }}
          className="flex h-56 max-w-full min-w-0 flex-col border border-border bg-card/50"
        >
          <div className="flex h-10 shrink-0 items-center border-b border-border px-3 text-xs">Canales</div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs text-muted-foreground">Canal de voz</div>
          <CallStatusBar
            name="Llamada de voz"
            status="Conectado"
            participants="4 participantes"
            isMuted={isMuted}
            isMinimized={isMinimized}
            onToggleMute={() => setIsMuted(value => !value)}
            onHangUp={hangUp}
            onExpand={expand}
            onOpenSoundboard={() => setIsSoundboardOpen(value => !value)}
            onOpenWatch={() => setIsWatching(value => !value)}
            isWatching={isWatching}
            hasWatchInvitation={active('invite')}
            onOpenSources={() => setIsSourcesOpen(value => !value)}
            isSourcesOpen={isSourcesOpen}
          />
          <div className="flex h-10 shrink-0 items-center border-t border-border px-3 text-xs">Perfil</div>
        </div>
      </section>
      <section aria-label="Vista expandida" className="space-y-2">
        <h2 className="text-xs text-muted-foreground">Controles expandidos — componente real</h2>
        <div id="expanded-frame" className="w-full min-w-0 border border-border">
          <CallExpandedControls
            isSourcesOpen={isSourcesOpen}
            onToggleSources={() => setIsSourcesOpen(value => !value)}
            isMuted={isMuted}
            onToggleMute={() => setIsMuted(value => !value)}
            isCameraOn={isCameraOn}
            onToggleCamera={() => setIsCameraOn(value => !value)}
            isScreenShareStarting={false}
            isScreenSharing={isScreenSharing}
            onToggleScreenShare={() => setIsScreenSharing(value => !value)}
            screenShareNotice={isScreenSharing ? 'Compartiendo pantalla; audio de pantalla disponible' : null}
            isSoundboardOpen={isSoundboardOpen}
            onToggleSoundboard={() => setIsSoundboardOpen(value => !value)}
            isWatching={isWatching}
            hasWatchInvitation={active('invite')}
            onToggleWatch={() => setIsWatching(value => !value)}
            onHangUp={hangUp}
            onMinimize={minimize}
          />
        </div>
      </section>
      <p id="probe-counts" className="text-xs text-muted-foreground">
        Expandir: {counters.expanded} · Colgar: {counters.hungUp} · Minimizar: {counters.minimized}
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<LayoutProbe />);