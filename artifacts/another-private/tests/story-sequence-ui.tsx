// Standalone synthetic-only check of the real story bar/viewer; API requests are stubbed.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoryBar } from '../src/components/story-bar';
import '../src/index.css';

const storyIds = [801, 802, 803];
const viewed = new Set<number>();
const fetchLog: string[] = [];
const svg = (label: string) => `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="400"><rect width="100%" height="100%" fill="#123"/><text x="24" y="200" fill="white">${label}</text></svg>`,
)}`;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  const method = (init.method ?? 'GET').toUpperCase();
  fetchLog.push(`${method} ${url.pathname}`);
  if (url.pathname === '/api/stories' && method === 'GET') {
    return new Response(JSON.stringify([{
      userId: 901,
      username: 'synthetic-author',
      displayName: 'Persona de prueba',
      avatarUrl: null,
      stories: storyIds.map((id, index) => ({
        id, mediaUrl: svg(`Historia ${index + 1}`), mediaType: 'image',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date(Date.now() + index * 1000).toISOString(),
        viewed: viewed.has(id),
      })),
      hasUnviewed: storyIds.some(id => !viewed.has(id)),
    }]), { headers: { 'Content-Type': 'application/json' } });
  }
  const viewMatch = url.pathname.match(/^\/api\/stories\/(\d+)\/view$/);
  if (viewMatch && method === 'POST') {
    viewed.add(Number(viewMatch[1]));
    return new Response(null, { status: 204 });
  }
  if (/^\/api\/stories\/\d+\/viewers$/.test(url.pathname)) {
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  }
  return originalFetch(input, init);
};

const root = createRoot(document.getElementById('root')!);
const results = document.getElementById('results')!;
const failures: string[] = [];
const check = (condition: boolean, label: string) => { if (!condition) failures.push(label); };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
root.render(<main className="mx-auto max-w-xl bg-background p-4 text-foreground">
  <StoryBar currentUserId={2} currentUser={{ username: 'synthetic-viewer' }} />
</main>);

void (async () => {
  await wait(120);
  const authorButton = document.querySelector<HTMLButtonElement>('[aria-label^="Ver 3 historias de Persona de prueba"]');
  check(Boolean(authorButton), 'the other author advertises three available stories');
  check(Boolean(authorButton?.getAttribute('aria-label')?.includes('hay historias sin ver')),
    'multiple unviewed stories set the group indicator');
  check(Boolean(authorButton?.querySelector('div')?.className.includes('bg-gradient-to-tr')),
    'the unviewed group uses the existing prominent ring token');
  authorButton?.click();
  await wait(100);
  // StoryViewer has no testing-only props; its actual story image is identified
  // by the data URI in this fixture through the image URL.
  const currentImage = () => document.querySelector<HTMLImageElement>('.fixed img[alt=""]');
  check(Boolean(currentImage()?.src.includes('Historia%201')), 'viewer begins with the first story');
  check(viewed.has(storyIds[0]), 'opening records the first story view individually');
  const next = () => document.querySelector<HTMLButtonElement>('[aria-label="Siguiente"]')?.click();
  next();
  await wait(100);
  check(Boolean(currentImage()?.src.includes('Historia%202')), 'next advances to the second story');
  check(viewed.has(storyIds[1]), 'advancing records the second story view separately');
  next();
  await wait(100);
  check(Boolean(currentImage()?.src.includes('Historia%203')), 'next advances to the third story');
  check(viewed.has(storyIds[2]), 'advancing records the third story view separately');
  check(storyIds.every(id => fetchLog.includes(`POST /api/stories/${id}/view`)),
    'a separate view request is sent for every story');
  next();
  await wait(100);
  check(!document.querySelector('.fixed.inset-0'), 'the sequence closes after the last story');
  results.textContent = failures.length ? `FAIL: ${failures.join('; ')}` :
    'PASS: grupo sin ver, secuencia 1→2→3 y tres registros de visualización individuales';
  results.setAttribute('data-status', failures.length ? 'fail' : 'pass');
  console.log(results.textContent);
})().catch(error => {
  results.textContent = `FAIL: ${String(error)}`;
  results.setAttribute('data-status', 'fail');
});