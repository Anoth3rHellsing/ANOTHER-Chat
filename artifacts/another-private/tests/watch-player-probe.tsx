// Development-only, unauthenticated fixture: no owner account or server mutations.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WatchPlayer } from '../src/components/watch-player';
import '../src/index.css';

const track = new URLSearchParams(location.search).get('track') ?? 'https://soundcloud.com/forss/flickermood';

function Fixture() {
  const [volume, setVolume] = useState(0.6);
  const [playing, setPlaying] = useState(true);
  const [positionMs, setPositionMs] = useState(0);
  const [updatedAtMs, setUpdatedAtMs] = useState(Date.now());
  (window as any).watchPlaying = playing;
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
  return <>
    <button id="activate" onClick={() => {
      document.querySelector<HTMLButtonElement>('[data-testid="button-watch-player-retry"]')?.click();
    }}>Activar sonido localmente</button>
    <WatchPlayer
      current={{
        id: 'fixture-track', platform: 'soundcloud', contentId: 'forss/flickermood',
        canonicalUrl: track, addedById: 1, addedByName: 'Prueba',
        title: 'Pista pública de prueba',
      }}
      playing={playing}
      positionMs={positionMs}
      updatedAtMs={updatedAtMs}
      localVolume={volume}
      canControl
      sessionKey="fixture-no-owner-data"
      onVolumeChange={setVolume}
      onPlay={() => { setPlaying(true); setUpdatedAtMs(Date.now()); }}
      onPause={position => { setPlaying(false); setPositionMs(position); setUpdatedAtMs(Date.now()); }}
      onSeek={position => { setPositionMs(position); setUpdatedAtMs(Date.now()); }}
      onEnded={() => { setPlaying(false); }}
      onMetadata={() => {}}
    />
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);