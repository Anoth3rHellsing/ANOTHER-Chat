import { useEffect, useRef, useState } from 'react';
import { VideoOff } from 'lucide-react';

function RemoteAudio({ peerId, stream }: { peerId: number; stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    let disposed = false;
    let retryPending = false;
    const attemptPlay = () => {
      if (disposed) return;
      void audio.play().then(() => {
        if (retryPending) {
          retryPending = false;
          window.removeEventListener('pointerdown', attemptPlay);
          window.removeEventListener('keydown', attemptPlay);
          console.info(`[voz][par ${peerId}] Reproducción remota reanudada`);
        }
      }).catch(error => {
        if (!retryPending) {
          retryPending = true;
          console.warn(`[voz][par ${peerId}] Autoplay bloqueado; se reintentará tras una interacción`, error);
          window.addEventListener('pointerdown', attemptPlay);
          window.addEventListener('keydown', attemptPlay);
        }
      });
    };
    attemptPlay();
    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', attemptPlay);
      window.removeEventListener('keydown', attemptPlay);
      audio.pause();
      audio.srcObject = null;
    };
  }, [peerId, stream]);

  // Audio without controls has no visual footprint and stays mounted outside the call overlay.
  return <audio ref={audioRef} autoPlay data-voice-peer={peerId} />;
}

export function RemoteAudioStreams({ streams }: { streams: Map<number, MediaStream> }) {
  return <>{[...streams].map(([peerId, stream]) =>
    <RemoteAudio key={peerId} peerId={peerId} stream={stream} />
  )}</>;
}

export function RemoteVideo({ stream, fit = 'cover' }: { stream: MediaStream; fit?: 'cover' | 'contain' }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    const update = () => setHasVideo(stream.getVideoTracks().some(track =>
      track.readyState === 'live' && !track.muted
    ));
    let tracks: MediaStreamTrack[] = [];
    const refreshTracks = () => {
      tracks.forEach(track => {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      });
      tracks = stream.getVideoTracks();
      tracks.forEach(track => {
        track.addEventListener('mute', update);
        track.addEventListener('unmute', update);
        track.addEventListener('ended', update);
      });
      update();
    };
    stream.addEventListener('addtrack', refreshTracks);
    stream.addEventListener('removetrack', refreshTracks);
    refreshTracks();
    return () => {
      stream.removeEventListener('addtrack', refreshTracks);
      stream.removeEventListener('removetrack', refreshTracks);
      tracks.forEach(track => {
        track.removeEventListener('mute', update);
        track.removeEventListener('unmute', update);
        track.removeEventListener('ended', update);
      });
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <div className="relative h-full w-full">
      <video ref={videoRef} autoPlay muted playsInline
        className={`h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'} ${hasVideo ? '' : 'invisible'}`} />
      {!hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center bg-secondary text-muted-foreground">
          <VideoOff className="h-9 w-9" aria-label="Cámara apagada" />
        </div>
      )}
    </div>
  );
}