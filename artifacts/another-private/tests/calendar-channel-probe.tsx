import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateChannelModal } from '../src/components/create-channel-modal';
import { ChannelEventsPanel } from '../src/components/channel-events';
import '../src/index.css';

declare global {
  interface Window {
    calendarChannelProbe?: {
      events: any[];
      requests: Array<{ method: string; path: string; body: unknown }>;
      channel: { id: number; name: string; channelType: string } | null;
    };
  }
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
const channelId = 778;
const requests: Array<{ method: string; path: string; body: unknown }> = [];
let testEvents: any[] = [];
let createdChannel: { id: number; name: string; channelType: string } | null = null;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let body: any = null;
  if (typeof init.body === 'string') {
    try { body = JSON.parse(init.body); } catch { body = null; }
  }
  requests.push({ method, path: url.pathname, body });

  if (method === 'POST' && url.pathname === '/api/servers/9/channels') {
    createdChannel = { id: channelId, serverId: 9, name: body.name, channelType: body.channelType };
    return response(createdChannel, 201);
  }
  if (url.pathname === `/api/channels/${channelId}/events` && method === 'GET') {
    return response(testEvents);
  }
  if (url.pathname === `/api/channels/${channelId}/events` && method === 'POST') {
    const event = {
      id: 8801,
      channelId,
      creatorId: 1,
      creator: { id: 1, username: 'fixture', displayName: 'Usuario de prueba', avatarUrl: null },
      title: body.title,
      description: body.description,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      originalTimeZone: body.originalTimeZone,
      canceledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      responses: [],
      counts: { yes: 0, no: 0, maybe: 0 },
      myResponse: null,
    };
    testEvents = [event];
    return response(event, 201);
  }
  const rsvpMatch = url.pathname.match(new RegExp(`^/api/channels/${channelId}/events/(\\d+)/response$`));
  if (rsvpMatch && method === 'PUT' && testEvents[0]) {
    const status = body.status;
    testEvents = [{
      ...testEvents[0],
      responses: [{
        userId: 1,
        status,
        updatedAt: new Date().toISOString(),
        user: { name: 'fixture', displayName: 'Usuario de prueba', avatarUrl: null },
      }],
      counts: { yes: Number(status === 'yes'), no: Number(status === 'no'), maybe: Number(status === 'maybe') },
      myResponse: { userId: 1, status },
    }];
    return response(testEvents[0]);
  }
  const eventMatch = url.pathname.match(new RegExp(`^/api/channels/${channelId}/events/(\\d+)$`));
  if (eventMatch && method === 'GET' && testEvents[0]) return response(testEvents[0]);
  return response({ error: `Unexpected isolated test request: ${method} ${url.pathname}` }, 500);
};

function CalendarChannelProbe() {
  const [channel, setChannel] = useState<typeof createdChannel>(() =>
    new URLSearchParams(location.search).get('view') === 'calendar'
      ? { id: channelId, name: 'events-live-test', channelType: 'calendar' }
      : null,
  );
  const [isCreateOpen, setIsCreateOpen] = useState(true);
  window.calendarChannelProbe = {
    get events() { return testEvents; },
    requests,
    channel,
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 p-4">
      <h1 className="text-sm font-semibold text-primary">Prueba aislada — creación y calendario de canal</h1>
      <p data-testid="calendar-channel-status" className="text-xs text-muted-foreground">
        Tipo guardado: {channel?.channelType ?? 'aún sin crear'}
      </p>
      {channel ? (
        <div className="flex min-h-[70vh] flex-1 flex-col border border-border">
          <ChannelEventsPanel
            key={channel.id}
            channelId={channel.id}
            onClose={() => {}}
            currentUser={{ id: 1 }}
            userPermissions={0}
            layout="main"
          />
        </div>
      ) : (
        <CreateChannelModal
          isOpen={isCreateOpen}
          onClose={() => setIsCreateOpen(false)}
          serverId={9}
          onCreated={created => {
            setChannel(created);
            setIsCreateOpen(false);
          }}
        />
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <CalendarChannelProbe />
  </QueryClientProvider>,
);