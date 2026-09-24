export type RemoteAudioRole = 'microphone' | 'screen';

export function identifyRemoteAudioRole(
  audioTransceivers: readonly RTCRtpTransceiver[],
  transceiver: RTCRtpTransceiver,
): RemoteAudioRole {
  return audioTransceivers.indexOf(transceiver) > 0 ? 'screen' : 'microphone';
}

export function classifyRemoteVideoStream(
  streamId: string | undefined,
  audioStreamRoles: ReadonlyMap<string, RemoteAudioRole>,
): RemoteAudioRole | null {
  if (!streamId) return null;
  const directRole = audioStreamRoles.get(streamId);
  if (directRole) return directRole;

  const microphoneStreamIds = [...audioStreamRoles]
    .filter(([, role]) => role === 'microphone')
    .map(([id]) => id);
  if (!microphoneStreamIds.length) return null;
  return microphoneStreamIds.includes(streamId) ? null : 'screen';
}

export function getLiveScreenTracks(
  stream: Pick<MediaStream, 'getVideoTracks' | 'getAudioTracks'> | null,
  committed: boolean,
): { video: MediaStreamTrack | null; audio: MediaStreamTrack | null } | null {
  if (!stream || !committed) return null;
  return {
    video: stream.getVideoTracks().find(track => track.readyState === 'live') ?? null,
    audio: stream.getAudioTracks().find(track => track.readyState === 'live') ?? null,
  };
}

export function enqueuePeerTrackOperation(
  queues: Map<number, Promise<void>>,
  peerId: number,
  operation: () => void | Promise<void>,
): Promise<void> {
  const previous = queues.get(peerId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(peerId, current.then(() => undefined, () => undefined));
  return current;
}

export function enqueueCurrentPeerTrackOperation(
  queues: Map<number, Promise<void>>,
  peerId: number,
  generation: number,
  currentGeneration: () => number,
  isCurrent: () => boolean,
  operation: () => void | Promise<void>,
): Promise<void> {
  return enqueuePeerTrackOperation(queues, peerId, async () => {
    if (generation !== currentGeneration() || !isCurrent()) return;
    await operation();
  });
}