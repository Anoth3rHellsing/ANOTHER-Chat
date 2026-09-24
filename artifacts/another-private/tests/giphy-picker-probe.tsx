import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GifPicker } from '../src/components/gif-picker';
import { GifMessage } from '../src/components/gif-message';
import { serializeGiphyMessage } from '../src/lib/giphy';
import '../src/index.css';

declare global {
  interface Window {
    gifProbe?: { requests: string[]; selected: string | null };
  }
}

const unavailable = new URLSearchParams(location.search).has('unavailable');
const requests: string[] = [];
const exampleGif = 'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif';
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.pathname === '/api/giphy/status') {
    requests.push(url.pathname);
    return Response.json(unavailable
      ? { available: false, message: 'El selector de GIF no está disponible: falta configurar GIPHY.' }
      : { available: true });
  }
  if (url.pathname === '/api/giphy/search') {
    requests.push(`${url.pathname}${url.search}`);
    const query = url.searchParams.get('q') ?? '';
    return Response.json({
      data: [
        { id: 'fixture-1', title: query ? `Resultado: ${query}` : 'GIF en tendencia', url: exampleGif },
      ],
      nextOffset: 1,
      hasMore: false,
    });
  }
  return originalFetch(input, init);
};

function Probe() {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  window.gifProbe = { requests, selected };
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 p-5">
      <h1 className="text-lg font-semibold text-primary">Prueba aislada — selector de GIF en el campo de escritura</h1>
      <div className="relative flex items-center rounded-xl border border-border bg-card">
        <button type="button" className="p-3 text-muted-foreground" title="Insertar emoji">☻</button>
        <button type="button" data-testid="button-probe-gif" className="p-2 text-xs font-semibold text-primary" onClick={() => setOpen(value => !value)}>GIF</button>
        <input aria-label="Mensaje" placeholder="Escribir mensaje..." className="min-w-0 flex-1 bg-transparent px-2 py-3 text-foreground" />
        {open && <GifPicker onSelect={gif => setSelected(serializeGiphyMessage(gif.url))} onClose={() => setOpen(false)} />}
      </div>
      <section>
        <h2 className="text-sm text-muted-foreground">Mensaje recibido por el renderizador real:</h2>
        {selected ? <GifMessage content={selected} /> : <p className="text-xs text-muted-foreground">Selecciona un GIF para verlo aquí.</p>}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Probe />);