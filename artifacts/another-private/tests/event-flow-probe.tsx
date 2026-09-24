// Browser interaction probe with simulated responses only; no owner account or data is used.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelEventsEntry, ChannelEventsPanel, EventMessageCard } from '../src/components/channel-events';
import '../src/index.css';

type EventRecord = {
  id: number; channelId: number; creatorId: number; title: string; description: string | null;
  startsAt: string; endsAt: string | null; originalTimeZone: string; canceledAt: null;
  createdAt: string; updatedAt: string; responses: unknown[];
  creator: { id: number; username: string; displayName: string; avatarUrl: null };
  counts: { yes: number; no: number; maybe: number }; myResponse: { status: string } | null;
};
const now = new Date();
const creator = { id: 1, username: 'fixture', displayName: 'Persona temporal', avatarUrl: null };
const records: EventRecord[] = [{
  id: 11, channelId: 1, creatorId: 1, title: 'Actividad pasada de ejemplo', description: null,
  startsAt: new Date(now.getTime() - 86_400_000).toISOString(), endsAt: null, originalTimeZone: 'UTC',
  canceledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  responses: [], creator, counts: { yes: 0, no: 0, maybe: 0 }, myResponse: null,
}];
let createdId: number | null = null;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith('/api/channels/1/events')) return realFetch(input, init);
  const method = init?.method ?? 'GET';
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
  if (url.pathname === '/api/channels/1/events' && method === 'GET') return json(records);
  if (url.pathname === '/api/channels/1/events' && method === 'POST') {
    const data = JSON.parse(String(init?.body));
    const event: EventRecord = {
      ...data, id: 12, channelId: 1, creatorId: 1, creator,
      canceledAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      responses: [], counts: { yes: 0, no: 0, maybe: 0 }, myResponse: null,
    };
    records.push(event);
    createdId = event.id;
    window.dispatchEvent(new Event('fixture-event-created'));
    return json(event, 201);
  }
  const id = Number(url.pathname.match(/\/events\/(\d+)/)?.[1]);
  const event = records.find(item => item.id === id);
  if (!event) return json({ error: 'No encontrado' }, 404);
  if (method === 'PUT' && url.pathname.endsWith('/response')) {
    const { status } = JSON.parse(String(init?.body));
    event.myResponse = { status };
    event.counts = { yes: Number(status === 'yes'), no: Number(status === 'no'), maybe: Number(status === 'maybe') };
    return json(event);
  }
  return json(event);
};
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Probe() {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<number | null>(null);
  React.useEffect(() => {
    const listener = () => setAnnouncement(createdId);
    window.addEventListener('fixture-event-created', listener);
    return () => window.removeEventListener('fixture-event-created', listener);
  }, []);
  return <div className="flex h-screen bg-background text-foreground">
    <aside className="hidden w-44 flex-shrink-0 border-r border-border bg-card p-4 md:block">Canales<br /><span className="text-sm text-primary"># general</span></aside>
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-12 flex-shrink-0 items-center justify-between border-b border-border bg-card px-4">
        <strong># general</strong>
        <ChannelEventsEntry channelName="general" open={open} onClick={() => setOpen(value => !value)} />
      </header>
      <main className="flex-1 p-6">
        <p className="text-sm text-muted-foreground">Flujo de mensajes — datos simulados</p>
        {announcement && <article className="mt-4 max-w-sm rounded-lg border border-border bg-card p-3">
          <p className="text-sm">Persona temporal · Nueva actividad: {records.find(event => event.id === announcement)?.title}</p>
          <EventMessageCard eventId={announcement} channelId={1} onOpenEvents={() => setOpen(true)} />
        </article>}
        <pre id="result" className="mt-5 text-xs" aria-live="polite">Comprobando interfaz…</pre>
      </main>
    </div>
    {open && <ChannelEventsPanel channelId={1} onClose={() => setOpen(false)} currentUser={creator} userPermissions={0} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await pause(15);
  }
}
const failures: string[] = [];
function check(ok: boolean, label: string) { if (!ok) failures.push(label); }
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
void (async () => {
  await waitUntil(() => Boolean(document.querySelector('button[aria-label="Eventos del canal general"]')));
  const entry = document.querySelector<HTMLButtonElement>('button[aria-label="Eventos del canal general"]');
  check(Boolean(entry?.textContent?.includes('Eventos')), 'punto de entrada visible');
  entry?.click();
  await waitUntil(() => Boolean(document.querySelector('#channel-events-panel')?.textContent?.includes('Actividad pasada de ejemplo')));
  check(Boolean(document.querySelector('#channel-events-panel')?.textContent?.includes('Actividad pasada de ejemplo')),
    'lista pasada desde la interfaz');
  check(Boolean(document.querySelector('#channel-events-panel')?.textContent?.includes('No hay eventos próximos')),
    'estado de próximos visible');
  document.querySelector<HTMLButtonElement>('button[title="Crear evento"]')?.click();
  await waitUntil(() => Boolean(document.querySelector('#channel-events-panel form')));
  const form = document.querySelector<HTMLFormElement>('#channel-events-panel form');
  const title = form?.querySelector<HTMLInputElement>('input[type=text]');
  const start = form?.querySelector<HTMLInputElement>('input[type=datetime-local]');
  if (title && start) {
    setInput(title, 'Noche de cine temporal');
    const future = new Date(Date.now() + 2 * 86_400_000);
    const local = new Date(future.getTime() - future.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setInput(start, local);
    form?.requestSubmit();
  }
  await waitUntil(() => Boolean(document.querySelector('#channel-events-panel')?.textContent?.includes('Noche de cine temporal')));
  check(Boolean(createdId), 'crear evento desde formulario');
  check(Boolean(document.querySelector('#channel-events-panel')?.textContent?.includes('Noche de cine temporal')),
    'nuevo evento listado como próximo');
  check(Boolean(document.querySelector('main')?.textContent?.includes('Nueva actividad: Noche de cine temporal') &&
    document.querySelector('main')?.textContent?.includes('Evento Anunciado')), 'anuncio visible en flujo');
  const card = [...document.querySelectorAll<HTMLElement>('#channel-events-panel [role=button]')]
    .find(element => element.textContent?.includes('Noche de cine temporal'));
  card?.click();
  await waitUntil(() => Boolean(document.querySelector('button[aria-label="Responder Asistiré"]')));
  document.querySelector<HTMLButtonElement>('button[aria-label="Responder Asistiré"]')?.click();
  await waitUntil(() => Boolean(document.querySelector('#channel-events-panel button[aria-label="Responder Asistiré"]')?.className.includes('bg-primary')));
  check(records.find(event => event.id === createdId)?.myResponse?.status === 'yes', 'asistencia guardada');
  check(Boolean(document.querySelector('#channel-events-panel button[aria-label="Responder Asistiré"]')?.className.includes('bg-primary')),
    'asistencia reflejada en pantalla');
  const result = document.getElementById('result')!;
  result.textContent = failures.length ? `FAIL: ${failures.join('; ')}` : 'PASS: acceso, creación, lista, asistencia y anuncio';
  result.setAttribute('data-status', failures.length ? 'fail' : 'pass');
  console.log(result.textContent);
})().catch(error => { console.error('FAIL: prueba de eventos', error); });