import { Monitor } from 'lucide-react';
import { RemoteVideo } from './remote-audio';

export interface SharedScreen {
  key: string;
  stream: MediaStream;
  label: string;
  local: boolean;
  visible: boolean;
  audioAvailable?: boolean;
}

export function CallScreenGallery({ screens, featuredKey, onFeature }: {
  screens: SharedScreen[];
  featuredKey: string | null;
  onFeature: (key: string) => void;
}) {
  if (!screens.length) return null;
  const visible = screens.filter(screen => screen.visible);
  const featured = visible.find(screen => screen.key === featuredKey) ?? visible[0];

  return (
    <div className="flex min-h-0 flex-[2] flex-col gap-3 overflow-auto md:flex-row" aria-label="Pantallas compartidas">
      {!featured && (
        <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
          Las pantallas compartidas están ocultas para ti. Puedes volver a mostrarlas desde Fuentes.
        </p>
      )}
      {screens.map(screen => {
        const selected = screen.key === featured?.key;
        return (
          <div
            key={screen.key}
            hidden={!screen.visible}
            aria-hidden={!screen.visible}
            className={`${screen.visible ? 'relative' : 'hidden'} ${
              selected
                ? 'order-first min-h-[160px] min-w-0 flex-1 border-primary/40 md:min-w-[50%]'
                : 'order-last h-24 min-w-36 flex-shrink-0 md:h-32 md:w-40'
            } overflow-hidden rounded-2xl border bg-secondary`}
          >
            <RemoteVideo stream={screen.stream} fit="contain" />
            {selected ? (
              <span className="absolute bottom-2 left-3 rounded-md bg-card/90 px-2 py-1 font-mono text-xs text-foreground">
                <Monitor className="mr-1 inline h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {screen.label} — pantalla destacada
                {screen.local && !screen.audioAvailable && (
                  <span className="block text-muted-foreground">Sin audio de la pantalla</span>
                )}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onFeature(screen.key)}
                aria-label={`Destacar pantalla de ${screen.label}`}
                className="absolute inset-0 flex items-end p-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              >
                <span className="w-full truncate rounded bg-card/90 px-1.5 py-0.5 text-xs text-foreground">{screen.label}</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}