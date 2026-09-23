import { useEffect, useRef } from 'react';

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

export function RemoteVideo({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    return () => { video.srcObject = null; };
  }, [stream]);
  return <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />;
}