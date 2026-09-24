// Disposable browser fixture: simulated SDKs, no accounts or persisted data.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WatchPlayer } from '../src/components/watch-player';
import type { WatchItem } from '../src/lib/watch-session';
import '../src/index.css';

type Entry = { event: string; item: string; attached?: boolean };
const log: Entry[] = [];
const errors: string[] = [];
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
const item = (id: string, platform: 'youtube' | 'soundcloud'): WatchItem => ({
  id, platform, contentId: platform === 'youtube' ? 'dQw4w9WgXcQ' : 'forss/flickermood',
  canonicalUrl: platform === 'youtube'
    ? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    : 'https://soundcloud.com/forss/flickermood',
  addedById: 1, addedByName: 'Fixture', title: id,
});
const queue = [item('sc1', 'soundcloud'), item('yt2', 'youtube'), item('sc2', 'soundcloud'),
  item('yt3', 'youtube'), item('sc3', 'soundcloud')];
let youtube: any;
let soundcloud: any;

class FakeYouTube {
  frame: HTMLIFrameElement;
  callbacks: any;
  id: string;
  constructor(node: HTMLElement, options: any) {
    this.id = (window as any).watchState.current;
    this.callbacks = options.events;
    this.frame = document.createElement('iframe');
    this.frame.title = `YouTube ${this.id}`;
    node.replaceWith(this.frame); // Reproduce the official SDK's DOM replacement.
    youtube = this;
    log.push({ event: 'yt.create', item: this.id });
    setTimeout(() => this.callbacks.onReady({ target: this }), 0);
  }
  playVideo() {}
  pauseVideo() {}
  seekTo() {}
  loadVideoById() {}
  cueVideoById() {}
  getCurrentTime() { return 0; }
  getDuration() { return 100; }
  getPlayerState() { return 1; }
  isMuted() { return false; }
  setVolume() {}
  mute() {}
  unMute() {}
  getVideoData() { return { title: this.id }; }
  destroy() {
    log.push({ event: 'yt.destroy', item: this.id, attached: this.frame.isConnected });
    if (this.id === 'yt3') throw new Error('Simulated YouTube destroy failure');
    this.frame.remove();
  }
}

const widgetEvents = {
  READY: 'READY', ERROR: 'ERROR', FINISH: 'FINISH', PLAY_PROGRESS: 'PLAY_PROGRESS',
};
function FakeSoundCloud(frame: HTMLIFrameElement) {
  const id = (window as any).watchState.current;
  if (id === 'sc3') throw new Error('Simulated SoundCloud initialization failure');
  const replacement = document.createElement('iframe');
  replacement.title = `SoundCloud ${id}`;
  frame.replaceWith(replacement); // Even a replacing widget must not affect React's children.
  const listeners = new Map<string, () => void>();
  const widget = {
    id,
    frame: replacement,
    bind(event: string, callback: () => void) {
      listeners.set(event, callback);
      if (event === widgetEvents.READY) setTimeout(callback, 0);
    },
    unbind(event: string) {
      log.push({ event: 'sc.unbind', item: id, attached: replacement.isConnected });
      listeners.delete(event);
    },
    load() {},
    play() {},
    pause() { log.push({ event: 'sc.pause', item: id, attached: replacement.isConnected }); },
    seekTo() {},
    setVolume() {},
    getVolume(callback: (volume: number) => void) { callback(60); },
    getPosition(callback: (position: number) => void) { callback(0); },
    getDuration(callback: (duration: number) => void) { callback(100000); },
    getCurrentSound(callback: (sound: { title: string; duration: number }) => void) {
      callback({ title: id, duration: 100000 });
    },
    isPaused(callback: (paused: boolean) => void) { callback(false); },
    finish() { listeners.get(widgetEvents.FINISH)?.(); },
  };
  soundcloud = widget;
  log.push({ event: 'sc.create', item: id });
  return widget;
}
Object.assign(FakeSoundCloud, { Events: widgetEvents });
Object.assign(window, {
  YT: { Player: FakeYouTube, PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } },
  SC: { Widget: FakeSoundCloud },
  watchLifecycle: { log, errors },
});

function Fixture() {
  const [current, setCurrent] = useState<WatchItem | null>(item('yt1', 'youtube'));
  const [pending, setPending] = useState(queue);
  (window as any).watchState = { current: current?.id ?? null, queue: pending.map(entry => entry.id) };
  const advance = () => {
    setCurrent(pending[0] ?? null);
    setPending(pending.slice(1));
  };
  (window as any).watchLifecycle.advance = advance;
  (window as any).watchLifecycle.finish = () => {
    if (current?.platform === 'youtube') youtube.callbacks.onStateChange({
      data: (window as any).YT.PlayerState.ENDED, target: youtube,
    });
    else soundcloud.finish();
  };
  return <div style={{ width: 520 }}>
    {current ? <WatchPlayer current={current} playing positionMs={0} updatedAtMs={Date.now()}
      localVolume={0.6} canControl sessionKey="isolated-lifecycle"
      onVolumeChange={() => {}} onPlay={() => {}} onPause={() => {}}
      onSeek={() => {}} onEnded={id => {
        if (id !== current.id) throw new Error('Stale finish callback');
        advance();
      }} onMetadata={() => {}} /> : <p data-testid="queue-empty">Sin reproducción · cola vacía</p>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);