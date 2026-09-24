// Disposable browser fixture: real WatchPanel/WatchPlayer, fake SDK, no account or API data.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WatchPanel } from '../src/components/watch-panel';
import { WatchPlayer } from '../src/components/watch-player';
import type { WatchSessionState } from '../src/lib/watch-session';
import '../src/index.css';

type Entry = { event: string; attached?: boolean; start?: number };
const log: Entry[] = [];
const errors: string[] = [];
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));

const item = {
  id: 'fixture-video',
  platform: 'youtube' as const,
  contentId: 'dQw4w9WgXcQ',
  canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  addedById: 1,
  addedByName: 'Persona anfitriona',
  title: 'Contenido de prueba',
};

class FakeYouTube {
  frame: HTMLIFrameElement;
  callbacks: any;
  constructor(node: HTMLElement, options: any) {
    this.callbacks = options.events;
    this.frame = document.createElement('iframe');
    node.replaceWith(this.frame);
    log.push({ event: 'create', start: options.playerVars.start });
    setTimeout(() => this.callbacks.onReady({ target: this }), 0);
  }
  playVideo() {}
  pauseVideo() {}
  seekTo() {}
  loadVideoById() {}
  cueVideoById() {}
  getCurrentTime() { return 0; }
  getDuration() { return 30; }
  getPlayerState() { return 1; }
  isMuted() { return false; }
  setVolume() {}
  mute() {}
  unMute() {}
  getVideoData() { return { title: 'Contenido de prueba' }; }
  destroy() {
    log.push({ event: 'destroy', attached: this.frame.isConnected });
    this.frame.remove();
  }
}

Object.assign(window, {
  YT: {
    Player: FakeYouTube,
    PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  },
  watchOptIn: { log, errors },
});

function Fixture() {
  const [session, setSession] = useState<WatchSessionState>({
    controllerUserId: 1,
    watchingUserIds: [1],
    allowEveryone: false,
    current: item,
    queue: [],
    playing: true,
    positionMs: 4_000,
    updatedAtMs: Date.now(),
    serverNowMs: Date.now(),
    revision: 1,
  });
  const isWatching = session.watchingUserIds.includes(2);
  const update = (next: WatchSessionState) => setSession(next);
  const join = () => update({
    ...session,
    watchingUserIds: session.watchingUserIds.includes(2)
      ? session.watchingUserIds : [...session.watchingUserIds, 2],
  });
  const leave = () => update({
    ...session,
    watchingUserIds: session.watchingUserIds.filter(id => id !== 2),
  });
  (window as any).watchOptIn.join = join;
  (window as any).watchOptIn.leave = leave;
  const participants = [
    { userId: 1, displayName: 'Persona anfitriona' },
    { userId: 2, displayName: 'Persona invitada' },
  ];
  const player = isWatching && session.current ? (
    <WatchPlayer
      current={session.current}
      playing={session.playing}
      positionMs={session.positionMs}
      updatedAtMs={session.updatedAtMs}
      localVolume={0.6}
      canControl={false}
      sessionKey="opt-in-fixture"
      onVolumeChange={() => {}}
      onPlay={() => {}}
      onPause={() => {}}
      onSeek={() => {}}
      onEnded={() => {}}
      onMetadata={() => {}}
    />
  ) : null;
  return <div className="h-screen bg-background p-4 text-foreground">
    <WatchPanel
      session={session}
      isWatching={isWatching}
      localVolume={0.6}
      onLocalVolumeChange={() => {}}
      canControl={false}
      onStart={() => {}}
      onAdd={() => {}}
      onJoin={join}
      onLeave={leave}
      onAction={() => {}}
      player={player}
      error={null}
      active="voice"
      participants={participants}
      currentUserId={2}
    />
  </div>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);