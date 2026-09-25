// Read-only visual fixture: synthetic responses; no project database or login.
import { createRoot } from 'react-dom/client';
import '../src/index.css';

const image = (name: string, color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${color}"/><text x="40" y="52" text-anchor="middle" font-size="36" fill="white">${name}</text></svg>`)}`;
const me = { id: 900001, username: 'demo', displayName: 'Demo Visual', role: 'admin', status: 'online', avatarUrl: image('D', '#357aa5') };
const peer = { id: 900002, username: 'prueba', displayName: 'Otra Persona', role: 'member', status: 'online', avatarUrl: '/api/uploads/missing-avatar.png' };
const channel = { id: 900003, serverId: 900004, name: 'conversación-general', channelType: 'text', position: 0 };
const message = (id: number, user: typeof me, content: string) => ({
  id, channelId: channel.id, userId: user.id, author: user, content,
  createdAt: new Date().toISOString(), reactions: [], attachments: [], deletedAt: null,
});
const server = { id: 900004, name: 'Servidor de prueba', ownerId: me.id, iconUrl: null };
const dm = { id: 900005, otherUser: peer, unreadCount: 0, lastMessage: null };
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
  const path = url.pathname;
  let body: unknown = [];
  if (path === '/api/auth/me') body = me;
  else if (path === '/api/servers') body = [server];
  else if (path === `/api/servers/${server.id}/channels`) body = [channel];
  else if (path === `/api/servers/${server.id}/members`) body = [
    { id: 1, userId: me.id, role: 'admin', user: me }, { id: 2, userId: peer.id, role: 'member', user: peer },
  ];
  else if (path === `/api/channels/${channel.id}/messages`) body = [
    message(900006, peer, 'Este es un mensaje de prueba completo que debe leerse con normalidad en una pantalla de 390 puntos de ancho.'),
    message(900007, me, 'También funciona la respuesta sin partir el texto en una letra por línea.'),
  ];
  else if (path === '/api/dms') body = [dm];
  else if (path === `/api/dms/${peer.id}`) body = [
    { id: 900008, senderId: peer.id, sender: peer, content: 'Conversación privada legible en móvil, con avatar y acciones disponibles.', createdAt: new Date().toISOString(), reactions: [], deletedAt: null },
  ];
  else if (path.includes('/admin/stats')) body = { userCount: 2, activeUserCount: 2, serverCount: 1, messageCount: 3 };
  else if (path.startsWith('/api/uploads/')) return new Response('', { status: 404 });
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

history.replaceState({}, '', new URLSearchParams(location.search).get('admin') === '1' ? '/app/admin' : '/app');
void import('../src/App').then(({ default: App }) =>
  createRoot(document.getElementById('root')!).render(<App />));