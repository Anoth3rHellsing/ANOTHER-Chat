// Development-only, unauthenticated fixture: no owner account or server mutations.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WatchPlayer } from '../src/components/watch-player';
import { WatchPanel } from '../src/components/watch-panel';
import { normalizeWatchUrl, type WatchItem } from '../src/lib/watch-session';
import '../src/index.css';

const track = new URLSearchParams(location.search).get('track') ?? 'https://soundcloud.com/forss/flickermood';
const initialTrack: WatchItem = {
  id: 'fixture-track', platform: 'soundcloud', contentId: 'forss/flickermood',
  canonicalUrl: track, addedById: 1, addedByName: 'Prueba',
  title: 'Pista pública de prueba',
};
const initialQueue: WatchItem[] = [
  {
    id: 'fixture-next-youtube', platform: 'youtube', contentId: 'dQw4w9WgXcQ',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    addedById: 2, addedByName: 'Otra persona', title: 'Vídeo de prueba',
  },
  {
    id: 'fixture-next-soundcloud', platform: 'soundcloud', contentId: 'forss/flickermood',
    canonicalUrl: track, addedById: 1, addedByName: 'Prueba', title: 'Otra pista de prueba',
  },
];

function Fixture() {
  const [volume, setVolume] = useState(0.6);
  const [playing, setPlaying] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [updatedAtMs, setUpdatedAtMs] = useState(Date.now());
  const [current, setCurrent] = useState<WatchItem>(initialTrack);
  const [queue, setQueue] = useState(initialQueue);
  (window as any).watchPlaying = playing;
  (window as any).controlEvents ??= [];
  useEffect(() => {
    (window as any).setWatchPlaying = (next: boolean) => {
      setPlaying(next);
      setUpdatedAtMs(Date.now());
    };
    (window as any).setWatchVolume = setVolume;
    const timer = setInterval(() => {
      const frame = document.querySelector<HTMLIFrameElement>('[data-testid="watch-soundcloud-player"]');
      const sc = (window as any).SC;
      if (!frame || !sc?.Widget || (window as any).widget) return;
      const widget = sc.Widget(frame);
      (window as any).widget = widget;
      (window as any).events = ['READY'];
      for (const name of ['PLAY', 'PAUSE', 'PLAY_PROGRESS', 'ERROR', 'SEEK']) {
        widget.bind(sc.Widget.Events[name], () => (window as any).events.push(name));
      }
      (window as any).readVolume = () => new Promise(resolve => widget.getVolume(resolve));
      (window as any).readPosition = () => new Promise(resolve => widget.getPosition(resolve));
    }, 100);
    return () => clearInterval(timer);
  }, []);
  const next = () => {
    if (queue.length === 0) return;
    setCurrent(queue[0]);
    setQueue(queue.slice(1));
    setPositionMs(0);
    setUpdatedAtMs(Date.now());
  };
  const action = (name: string, payload?: any) => {
    if (name === 'pause' || name === 'play') {
      setPlaying(name === 'play');
      setUpdatedAtMs(Date.now());
    } else if (name === 'skip' || name === 'ended') next();
    else if (name === 'seek') { setPositionMs(payload.positionMs); setUpdatedAtMs(Date.now()); }
    else if (name === 'remove') setQueue(items => items.filter(item => item.id !== payload.itemId));
    else if (name === 'reorder') setQueue(items => {
      const copy = [...items];
      const from = copy.findIndex(item => item.id === payload.itemId);
      if (from < 0 || payload.toIndex < 0 || payload.toIndex >= copy.length) return items;
      copy.splice(payload.toIndex, 0, ...copy.splice(from, 1));
      return copy;
    });
  };
  return <aside
    style={window.innerWidth < 768
      ? { position: 'fixed', top: 0, right: 0, bottom: '45dvh', width: '100%' }
      : { position: 'fixed', top: 16, right: 16, bottom: 96, width: 'min(520px, 40vw)' }}
    data-testid="watch-fixture"
  >
    <WatchPanel
      session={{
        current, queue, playing, positionMs, updatedAtMs, serverNowMs: Date.now(),
        revision: 1, controllerUserId: 1, allowEveryone: false,
      }}
      localVolume={volume}
      onLocalVolumeChange={setVolume}
      canControl
      onStart={() => {}}
      onAdd={url => {
        const parsed = normalizeWatchUrl(url);
        if (!parsed.ok) return;
        setQueue(items => [...items, {
          id: `fixture-${items.length}-${Date.now()}`, ...parsed,
          addedById: 1, addedByName: 'Prueba', title: 'Enlace añadido',
        }]);
      }}
      onAction={action}
      error={null}
      active="voice"
      currentUserId={1}
      player={<WatchPlayer
      current={current}
      playing={playing}
      positionMs={positionMs}
      updatedAtMs={updatedAtMs}
      localVolume={volume}
      canControl
      sessionKey="fixture-no-owner-data"
      onVolumeChange={setVolume}
      onPlay={() => { (window as any).controlEvents.push('play'); setPlaying(true); setUpdatedAtMs(Date.now()); }}
      onPause={position => { (window as any).controlEvents.push('pause'); setPlaying(false); setPositionMs(position); setUpdatedAtMs(Date.now()); }}
      onSeek={position => { (window as any).controlEvents.push('seek'); setPositionMs(position); setUpdatedAtMs(Date.now()); }}
      onEnded={next}
      onMetadata={() => {}}
    />}
    />
  </aside>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);