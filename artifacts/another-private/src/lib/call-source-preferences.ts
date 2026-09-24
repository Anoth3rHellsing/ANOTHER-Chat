export type CallAudioSource = 'microphone' | 'screen';
export type CallVideoSource = 'camera' | 'screen';

export interface SourceLevel {
  volume: number;
  muted: boolean;
}

export interface PeerSourcePreferences {
  microphone: SourceLevel;
  screen: SourceLevel;
  cameraVisible: boolean;
  screenVisible: boolean;
}

export const DEFAULT_PEER_SOURCE_PREFERENCES: Readonly<PeerSourcePreferences> = {
  microphone: { volume: 1, muted: false },
  screen: { volume: 1, muted: false },
  cameraVisible: true,
  screenVisible: true,
};

export function sourcePreferencesFor(
  preferences: ReadonlyMap<number, PeerSourcePreferences>,
  peerId: number,
): Readonly<PeerSourcePreferences> {
  return preferences.get(peerId) ?? DEFAULT_PEER_SOURCE_PREFERENCES;
}