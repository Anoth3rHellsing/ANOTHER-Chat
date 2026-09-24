import { useEffect, useRef, useState, useCallback } from 'react';
import { callMediaConstraints, safeCloseAudioContext, videoConstraintsFromQuality, type AudioVideoSettings as StoredAudioVideoSettings } from '@/lib/settings-utils';
import { createMicrophoneProcessor, updateNativeMicrophoneTrack, type MicrophoneProcessor } from '@/lib/microphone-processor';
import {
  classifyRemoteVideoStream,
  enqueueCurrentPeerTrackOperation,
  getLiveScreenTracks,
  identifyRemoteAudioRole,
} from '@/lib/webrtc-media-identity';
import { playVoiceJoinSound, playVoiceLeaveSound } from '@/lib/voice-sounds';
import { csrfFetch } from '@workspace/api-client-react';
import {
  useRealtimeMessages,
  useRealtimeTransport,
} from '@/providers/realtime-transport';
import { candidateType, getIceServers, logSelectedRoute, voiceDebug } from '@/lib/voice-ice';

type PeerMode = 'voice' | 'dm';
type PeerSession = {
  pc: RTCPeerConnection;
  mode: PeerMode;
  chain: Promise<void>;
  candidates: RTCIceCandidateInit[];
  makingOffer: boolean;
  ignoreOffer: boolean;
  ignoredUfrags: Set<string>;
  restartPending: boolean;
  restarts: number;
  localCandidates: Record<string, number>;
  remoteCandidates: number;
  queuedCandidates: number;
  negotiationPending: boolean;
};

export interface VoiceMember {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  status: string;
}

export type AudioVideoSettings = Partial<StoredAudioVideoSettings>;

type CallState = 'idle' | 'calling' | 'ringing' | 'connected';
type RemoteAudioTracks = {
  microphone: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  microphoneMid: string | null;
  screenMid: string | null;
};

const SIGNALING_MESSAGE_TYPES = [
  'voice:bound',
  'voice:member_join',
  'voice:member_leave',
  'voice:offer',
  'voice:answer',
  'voice:ice-candidate',
  'dm:call-invite',
  'dm:call-accepted',
  'dm:call-offer',
  'dm:call-sdp-answer',
  'dm:call-ice-candidate',
  'dm:call-reject',
  'dm:call-end',
] as const;

interface IncomingCall {
  callerId: number;
  callerName: string;
  callerAvatar?: string | null;
}

export function useWebRTC(options: {
  currentUserId: number;
  settings: AudioVideoSettings;
}) {
  const { currentUserId, settings } = options;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { send, retainChannel } = useRealtimeTransport();

  const peerConnections = useRef<Map<number, RTCPeerConnection>>(new Map());
  const sessionsRef = useRef<Map<number, PeerSession>>(new Map());
  const mediaPromiseRef = useRef<Promise<MediaStream | null> | null>(null);
  const mediaGenerationRef = useRef(0);
  const joinInProgressRef = useRef(false);
  const leaveInProgressRef = useRef(false);
  const lifecycleRef = useRef(0);
  const mountedRef = useRef(true);
  const speakerRef = useRef<number | null>(null);
  const dmCallUserIdRef = useRef<number | null>(null);
  const incomingCallerIdRef = useRef<number | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenSendersRef = useRef<Map<number, RTCRtpSender>>(new Map());
  const cameraSendersRef = useRef<Map<number, RTCRtpSender>>(new Map());
  const microphoneSendersRef = useRef<Map<number, RTCRtpSender>>(new Map());
  const screenAudioSendersRef = useRef<Map<number, RTCRtpSender>>(new Map());
  const screenAudioOperationsRef = useRef<Map<number, Promise<void>>>(new Map());
  const screenAudioGenerationRef = useRef(0);
  const screenShareCommittedRef = useRef(false);
  const remoteCompositeStreamsRef = useRef<Map<number, MediaStream>>(new Map());
  const remoteAudioStreamRolesRef = useRef<Map<number, Map<string, 'microphone' | 'screen'>>>(new Map());
  const pendingRemoteVideoTracksRef = useRef<Map<number, Map<string, {
    track: MediaStreamTrack;
    stream: MediaStream;
  }>>>(new Map());
  const screenOperationRef = useRef(0);
  const cameraOperationRef = useRef(0);
  const screenStartingRef = useRef(false);
  const screenCleaningRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<MicrophoneProcessor | null>(null);
  const processorOperationRef = useRef(0);
  const processorTaskRef = useRef<Promise<void>>(Promise.resolve());
  const activeMicTrackRef = useRef<MediaStreamTrack | null>(null);
  const nativeSettingsEpochRef = useRef(0);
  const nativeRecaptureAttemptRef = useRef('');
  const analyserRef = useRef<AnalyserNode | null>(null);
  const speakingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const activeVoiceChannelIdRef = useRef<number | null>(null);
  const voiceSubscriptionReleaseRef = useRef<(() => void) | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<number, MediaStream>>(new Map());
  const [remoteAudioTracks, setRemoteAudioTracks] = useState<Map<number, RemoteAudioTracks>>(new Map());
  const [activeSpeakerId, setActiveSpeakerId] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Map<number, MediaStream>>(new Map());
  const [screenAudioAvailable, setScreenAudioAvailable] = useState(false);
  const [isScreenShareStarting, setIsScreenShareStarting] = useState(false);
  const [screenShareNotice, setScreenShareNotice] = useState<string | null>(null);
  const [isInVoiceChannel, setIsInVoiceChannel] = useState(false);
  const [activeVoiceChannelId, setActiveVoiceChannelId] = useState<number | null>(null);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [callState, setCallState] = useState<CallState>('idle');
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [dmCallUserId, setDmCallUserId] = useState<number | null>(null);
  dmCallUserIdRef.current = dmCallUserId;

  // ── Signaling handler ──────────────────────────────────────────────────────

  const handleSignalingMessage = useCallback(async (msg: any) => {
    const peerId = Number(msg.data?.fromUserId ?? msg.data?.member?.userId ??
      msg.data?.userId ?? msg.data?.callerId ?? msg.data?.acceptorId);
    try {
      switch (msg.type) {
      case 'voice:bound': {
        const { channelId, userIds } = msg.data;
        if (channelId !== activeVoiceChannelIdRef.current) break;
        const generation = lifecycleRef.current;
        const stream = await startLocalMedia(false);
        if (!stream || channelId !== activeVoiceChannelIdRef.current ||
            generation !== lifecycleRef.current) break;
        for (const userId of userIds as number[]) {
          if (userId === currentUserId || currentUserId > userId ||
              generation !== lifecycleRef.current) continue;
          await offerPeer(userId, 'voice');
        }
        break;
      }
      case 'voice:member_join': {
        const { member, channelId } = msg.data;
        if (channelId !== activeVoiceChannelIdRef.current) break;
        if (member.userId === currentUserId) break;
        setVoiceMembers(prev => {
          if (prev.some(m => m.userId === member.userId)) return prev;
          return [...prev, member];
        });
        // Play sound for other members entering the channel
        playVoiceJoinSound();
        // Simultaneous joins can both receive an empty HTTP member list.
        // The lower user ID initiates when the other binding becomes visible.
        if (currentUserId < member.userId) {
          const stream = await startLocalMedia(false);
          if (stream && channelId === activeVoiceChannelIdRef.current) {
            await offerPeer(member.userId, 'voice');
          }
        }
        break;
      }

      case 'voice:member_leave': {
        const { userId, channelId } = msg.data;
        if (channelId !== activeVoiceChannelIdRef.current) break;
        setVoiceMembers(prev => prev.filter(m => m.userId !== userId));
        closePeerConnection(userId);
        // Play sound for other members leaving the channel
        playVoiceLeaveSound();
        break;
      }

      case 'voice:offer': {
        const { fromUserId, sdp, channelId } = msg.data;
        if (channelId !== activeVoiceChannelIdRef.current) break;
        await receiveOffer(fromUserId, sdp, 'voice');
        break;
      }

      case 'voice:answer': {
        const { fromUserId, sdp, channelId } = msg.data;
        if (channelId !== activeVoiceChannelIdRef.current) break;
        await receiveAnswer(fromUserId, sdp, 'voice');
        break;
      }

      case 'voice:ice-candidate': {
        const { fromUserId, candidate, channelId } = msg.data;
        if (channelId !== activeVoiceChannelIdRef.current) break;
        await receiveCandidate(fromUserId, candidate, 'voice');
        break;
      }

      // DM call signaling
      case 'dm:call-invite': {
        const { callerId, callerName, callerAvatar } = msg.data;
        if (dmCallUserIdRef.current !== null || incomingCallerIdRef.current !== null) break;
        incomingCallerIdRef.current = callerId;
        setIncomingCall({ callerId, callerName, callerAvatar });
        setCallState('ringing');
        break;
      }

      case 'dm:call-accepted': {
        const { acceptorId } = msg.data;
        if (dmCallUserIdRef.current !== acceptorId) break;
        setCallState('connected');
        setDmCallUserId(acceptorId);
        if (!await startDmCallOffer(acceptorId) && dmCallUserIdRef.current === acceptorId) {
          sendWS({ type: 'dm:call-end', targetUserId: acceptorId });
          dmCallUserIdRef.current = null;
          setCallState('idle');
          setDmCallUserId(null);
        }
        break;
      }

      case 'dm:call-offer': {
        const { fromUserId, sdp } = msg.data;
        if (dmCallUserIdRef.current !== fromUserId) break;
        await receiveOffer(fromUserId, sdp, 'dm');
        if (dmCallUserIdRef.current !== fromUserId) break;
        setCallState('connected');
        setDmCallUserId(fromUserId);
        break;
      }

      case 'dm:call-sdp-answer': {
        const { fromUserId, sdp } = msg.data;
        if (dmCallUserIdRef.current !== fromUserId) break;
        await receiveAnswer(fromUserId, sdp, 'dm');
        break;
      }

      case 'dm:call-ice-candidate': {
        const { fromUserId, candidate } = msg.data;
        if (dmCallUserIdRef.current !== fromUserId) break;
        await receiveCandidate(fromUserId, candidate, 'dm');
        break;
      }

      case 'dm:call-reject': {
        if (dmCallUserIdRef.current !== msg.data.fromUserId) break;
        cameraOperationRef.current += 1;
        closePeerConnection(msg.data.fromUserId);
        dmCallUserIdRef.current = null;
        incomingCallerIdRef.current = null;
        setIncomingCall(null);
        setCallState('idle');
        setDmCallUserId(null);
        if (activeVoiceChannelIdRef.current === null) {
          void cleanupScreenShare();
          stopLocalMedia();
        }
        break;
      }

      case 'dm:call-end': {
        if (dmCallUserIdRef.current !== msg.data.fromUserId &&
            incomingCallerIdRef.current !== msg.data.fromUserId) break;
        cameraOperationRef.current += 1;
        closePeerConnection(msg.data.fromUserId);
        dmCallUserIdRef.current = null;
        incomingCallerIdRef.current = null;
        setIncomingCall(null);
        setCallState('idle');
        setDmCallUserId(null);
        setRemoteStreams(new Map());
        if (activeVoiceChannelIdRef.current === null) {
          void cleanupScreenShare();
          stopLocalMedia();
        }
        break;
      }
      }
    } catch (error) {
      console.error(`[voz][par ${Number.isFinite(peerId) ? peerId : 'desconocido'}] Error en ${msg.type}`, error);
    }
  }, [currentUserId]);

  useRealtimeMessages(SIGNALING_MESSAGE_TYPES, handleSignalingMessage);

  function outgoingMicTrack(): MediaStreamTrack | null {
    return activeMicTrackRef.current ?? localStreamRef.current?.getAudioTracks()[0] ?? null;
  }

  async function routeMicrophone(track: MediaStreamTrack): Promise<boolean> {
    activeMicTrackRef.current = track;
    let succeeded = true;
    await Promise.all([...sessionsRef.current.entries()].map(async ([peerId]) => {
      const sender = microphoneSendersRef.current.get(peerId);
      if (sender && sender.track !== track) {
        try { await sender.replaceTrack(track); }
        catch (error) {
          succeeded = false;
          console.warn('[voz] No se pudo cambiar el procesado del micrófono', error);
        }
      }
    }));
    return succeeded;
  }

  function retireMicrophonePath(processor: MicrophoneProcessor | null, oldRaw?: MediaStreamTrack) {
    processor?.stop();
    oldRaw?.stop();
  }

  // ── Peer connection management ──────────────────────────────────────────────

  function getSession(peerId: number, mode: PeerMode): PeerSession {
    const existing = sessionsRef.current.get(peerId);
    if (existing) {
      if (existing.mode !== mode) throw new Error(`Par ${peerId} ocupado en ${existing.mode}`);
      return existing;
    }
    const pc = new RTCPeerConnection({ iceServers: getIceServers() });
    const session: PeerSession = {
      pc, mode, chain: Promise.resolve(), candidates: [], makingOffer: false,
      ignoreOffer: false, ignoredUfrags: new Set(), restartPending: false,
      restarts: 0, localCandidates: {},
      remoteCandidates: 0, queuedCandidates: 0, negotiationPending: false,
    };
    sessionsRef.current.set(peerId, session);
    peerConnections.current.set(peerId, pc);
    voiceDebug(peerId, 'par creado', { mode, rol: currentUserId > peerId ? 'cortés' : 'firme' });

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        const stream = localStreamRef.current!;
        const outgoing = track.kind === 'audio' ? (outgoingMicTrack() ?? track) : track;
        const sender = pc.addTrack(outgoing, stream);
        if (track.kind === 'video') cameraSendersRef.current.set(peerId, sender);
        if (track.kind === 'audio') microphoneSendersRef.current.set(peerId, sender);
      });
    }
    const committedScreenTracks = getLiveScreenTracks(
      screenStreamRef.current,
      screenShareCommittedRef.current,
    );
    if (screenStreamRef.current && committedScreenTracks) {
      const screenTrack = committedScreenTracks.video;
      if (screenTrack) {
        const sender = pc.addTrack(screenTrack, screenStreamRef.current);
        screenSendersRef.current.set(peerId, sender);
      }
      const screenAudioTrack = committedScreenTracks.audio;
      if (screenAudioTrack) {
        const sender = pc.addTrack(screenAudioTrack, screenStreamRef.current);
        screenAudioSendersRef.current.set(peerId, sender);
      }
    }
    pc.onsignalingstatechange = () => {
      voiceDebug(peerId, 'estado señalización', { estado: pc.signalingState });
      if (pc.signalingState === 'stable') {
        if (session.restartPending) void offerPeer(peerId, mode, true);
        else if (session.negotiationPending) {
          session.negotiationPending = false;
          void offerPeer(peerId, mode);
        }
      }
    };
    pc.oniceconnectionstatechange = () =>
      voiceDebug(peerId, 'estado ICE', { estado: pc.iceConnectionState });
    pc.onicecandidate = event => {
      if (!event.candidate) {
        voiceDebug(peerId, 'fin de candidatos locales', { porTipo: session.localCandidates });
        return;
      }
      const type = candidateType(event.candidate.candidate);
      session.localCandidates[type] = (session.localCandidates[type] ?? 0) + 1;
      voiceDebug(peerId, 'candidato local', { tipo: type, porTipo: session.localCandidates });
      sendWS({
        type: mode === 'dm' ? 'dm:call-ice-candidate' : 'voice:ice-candidate',
        targetUserId: peerId, candidate: event.candidate,
      });
    };
    pc.ontrack = event => {
      if (sessionsRef.current.get(peerId) !== session) return;
      const sourceStream = event.streams[0];
      const composite = remoteCompositeStreamsRef.current.get(peerId) ?? new MediaStream();
      remoteCompositeStreamsRef.current.set(peerId, composite);
      const audioStreamRoles = remoteAudioStreamRolesRef.current.get(peerId) ?? new Map();
      remoteAudioStreamRolesRef.current.set(peerId, audioStreamRoles);
      const addToComposite = (track: MediaStreamTrack) => {
        if (!composite.getTracks().some(existing => existing.id === track.id)) composite.addTrack(track);
      };
      const identifyRemoteAudio = (track: MediaStreamTrack, transceiver: RTCRtpTransceiver) => {
        // The microphone sender is always created first; screen capture adds a
        // second audio transceiver rather than replacing that negotiated MID.
        const audioTransceivers = session.pc.getTransceivers()
          .filter(item => item.receiver.track.kind === 'audio')
          .sort((a, b) => {
            if (a.mid === null || b.mid === null) return 0;
            return Number(a.mid) - Number(b.mid);
          });
        const role = identifyRemoteAudioRole(audioTransceivers, transceiver);
        const mid = transceiver.mid;
        setRemoteAudioTracks(prev => {
          const next = new Map(prev);
          const prior = next.get(peerId) ?? {
            microphone: null, screen: null, microphoneMid: null, screenMid: null,
          };
          next.set(peerId, role === 'screen'
            ? { ...prior, screen: track, screenMid: mid }
            : { ...prior, microphone: track, microphoneMid: mid });
          return next;
        });
        track.addEventListener('ended', () => {
          setRemoteAudioTracks(prev => {
            const prior = prev.get(peerId);
            if (!prior || (role === 'screen' ? prior.screen !== track : prior.microphone !== track)) return prev;
            const next = new Map(prev);
            next.set(peerId, role === 'screen'
              ? { ...prior, screen: null, screenMid: null }
              : { ...prior, microphone: null, microphoneMid: null });
            return next;
          });
        }, { once: true });
        // replaceTrack(null) mutes the receiver without ending the transceiver.
        // Re-render source availability on both stop and subsequent re-share.
        const refreshAvailability = () => setRemoteAudioTracks(prev => {
          const current = prev.get(peerId);
          if (!current || current[role] !== track) return prev;
          return new Map(prev);
        });
        track.addEventListener('mute', refreshAvailability);
        track.addEventListener('unmute', refreshAvailability);
        return role;
      };
      const showRemoteScreen = (track: MediaStreamTrack, stream: MediaStream) => {
        setRemoteScreenStreams(prev => new Map(prev).set(peerId, stream));
        voiceDebug(peerId, 'pantalla remota recibida');
        track.onended = () => {
          setRemoteScreenStreams(prev => {
            if (!prev.has(peerId)) return prev;
            const next = new Map(prev);
            next.delete(peerId);
            return next;
          });
          voiceDebug(peerId, 'pantalla remota finalizada');
        };
        track.onmute = () => setRemoteScreenStreams(prev => {
          if (!prev.has(peerId)) return prev;
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
        track.onunmute = () => setRemoteScreenStreams(prev => new Map(prev).set(peerId, stream));
      };

      if (event.track.kind === 'audio') {
        const role = identifyRemoteAudio(event.track, event.transceiver);
        if (sourceStream) {
          audioStreamRoles.set(sourceStream.id, role);
        }
        addToComposite(event.track);
        const pending = pendingRemoteVideoTracksRef.current.get(peerId);
        if (pending?.size) {
          const unresolved = new Map<string, { track: MediaStreamTrack; stream: MediaStream }>();
          for (const [streamId, video] of pending) {
            const pendingRole = classifyRemoteVideoStream(streamId, audioStreamRoles);
            if (pendingRole === 'microphone') {
              addToComposite(video.track);
            } else if (pendingRole === 'screen') {
              showRemoteScreen(video.track, video.stream);
            } else unresolved.set(streamId, video);
          }
          if (unresolved.size) pendingRemoteVideoTracksRef.current.set(peerId, unresolved);
          else pendingRemoteVideoTracksRef.current.delete(peerId);
        }
        setRemoteStreams(prev => new Map(prev).set(peerId, composite));
      } else if (event.track.kind === 'video') {
        const streamId = sourceStream?.id;
        const streamRole = classifyRemoteVideoStream(streamId, audioStreamRoles);
        if (streamRole === 'microphone') {
          addToComposite(event.track);
          setRemoteStreams(prev => new Map(prev).set(peerId, composite));
        } else if (streamRole === 'screen') {
          showRemoteScreen(event.track, sourceStream);
        } else if (!sourceStream || !streamId) {
          addToComposite(event.track);
          setRemoteStreams(prev => new Map(prev).set(peerId, composite));
        } else {
          const pending = pendingRemoteVideoTracksRef.current.get(peerId) ?? new Map();
          pending.set(streamId, { track: event.track, stream: sourceStream });
          pendingRemoteVideoTracksRef.current.set(peerId, pending);
          event.track.onended = () => pendingRemoteVideoTracksRef.current.get(peerId)?.delete(streamId);
        }
      } else {
        addToComposite(event.track);
        setRemoteStreams(prev => new Map(prev).set(peerId, composite));
      }
      voiceDebug(peerId, 'pista remota recibida', { tipo: event.track.kind });
    };
    pc.onconnectionstatechange = () => {
      voiceDebug(peerId, 'estado conexión', { estado: pc.connectionState, reinicios: session.restarts });
      if (pc.connectionState === 'connected') {
        session.restartPending = false;
        void logSelectedRoute(peerId, pc);
      } else if (pc.connectionState === 'failed' && session.restarts < 2) {
        session.restartPending = true;
        if (pc.signalingState === 'stable') void offerPeer(peerId, mode, true);
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeerConnection(peerId);
      }
    };
    return session;
  }

  function enqueuePeer(peerId: number, mode: PeerMode, task: (session: PeerSession) => Promise<void>): Promise<void> {
    const session = getSession(peerId, mode);
    const operation = session.chain.then(async () => {
      if (sessionsRef.current.get(peerId) !== session || session.pc.signalingState === 'closed') return;
      await task(session);
    });
    session.chain = operation.catch(error => {
      console.error(`[voz][par ${peerId}] Negociación ${mode} fallida`, error);
    });
    return session.chain;
  }

  async function flushCandidates(peerId: number, session: PeerSession): Promise<void> {
    while (session.pc.remoteDescription && session.candidates.length) {
      const candidate = session.candidates.shift()!;
      try {
        await session.pc.addIceCandidate(candidate);
      } catch (error) {
        console.error(`[voz][par ${peerId}] Candidato remoto no aplicable`, error);
      }
    }
    voiceDebug(peerId, 'cola de candidatos vaciada', {
      recibidos: session.remoteCandidates, enCola: session.candidates.length,
    });
  }

  async function receiveCandidate(peerId: number, candidate: RTCIceCandidateInit, mode: PeerMode): Promise<void> {
    if (!candidate) return;
    await enqueuePeer(peerId, mode, async session => {
      if (candidate.usernameFragment && session.ignoredUfrags.has(candidate.usernameFragment)) {
        voiceDebug(peerId, 'candidato de oferta ignorada descartado');
        return;
      }
      session.remoteCandidates += 1;
      if (!session.pc.remoteDescription || session.pc.signalingState === 'have-local-offer') {
        session.candidates.push(candidate);
        session.queuedCandidates += 1;
        voiceDebug(peerId, 'candidato remoto en cola', {
          tipo: candidateType(candidate.candidate ?? ''), recibidos: session.remoteCandidates,
          enCola: session.candidates.length,
        });
      } else {
        try {
          await session.pc.addIceCandidate(candidate);
          voiceDebug(peerId, 'candidato remoto aplicado', {
            tipo: candidateType(candidate.candidate ?? ''), recibidos: session.remoteCandidates,
            puestosEnCola: session.queuedCandidates,
          });
        } catch (error) {
          console.error(`[voz][par ${peerId}] Error al aplicar candidato remoto`, error);
        }
      }
    });
  }

  async function receiveOffer(peerId: number, sdp: string, mode: PeerMode): Promise<void> {
    // Acquire media before processing an offer; it must be included in the answer.
    const generation = lifecycleRef.current;
    if (mode === 'dm' && dmCallUserIdRef.current !== peerId) return;
    if (mode === 'voice' && activeVoiceChannelIdRef.current === null) return;
    if (!localStreamRef.current && !await startLocalMedia(false)) return;
    if (mode === 'dm' && dmCallUserIdRef.current !== peerId ||
        mode === 'voice' && (generation !== lifecycleRef.current || activeVoiceChannelIdRef.current === null)) {
      if (sessionsRef.current.size === 0 && activeVoiceChannelIdRef.current === null &&
          dmCallUserIdRef.current === null) stopLocalMedia();
      return;
    }
    await enqueuePeer(peerId, mode, async session => {
      const { pc } = session;
      const collision = session.makingOffer || pc.signalingState !== 'stable';
      const polite = currentUserId > peerId;
      if (collision && !polite) {
        session.ignoreOffer = true;
        for (const match of sdp.matchAll(/^a=ice-ufrag:(\S+)/gm)) {
          session.ignoredUfrags.add(match[1]);
        }
        if (session.ignoredUfrags.size > 8) {
          session.ignoredUfrags = new Set([...session.ignoredUfrags].slice(-8));
        }
        voiceDebug(peerId, 'colisión: oferta ajena ignorada', { rol: 'firme' });
        return;
      }
      if (collision) {
        voiceDebug(peerId, 'colisión: reversión de oferta local', { rol: 'cortés' });
        if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
      }
      session.ignoreOffer = false;
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await flushCandidates(peerId, session);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWS({
        type: mode === 'dm' ? 'dm:call-sdp-answer' : 'voice:answer',
        targetUserId: peerId, sdp: pc.localDescription?.sdp,
      });
      voiceDebug(peerId, 'respuesta local enviada');
    });
  }

  async function receiveAnswer(peerId: number, sdp: string, mode: PeerMode): Promise<void> {
    const session = sessionsRef.current.get(peerId);
    if (!session || session.mode !== mode) {
      voiceDebug(peerId, 'respuesta sin oferta local ignorada');
      return;
    }
    await enqueuePeer(peerId, mode, async current => {
      // This check occurs inside the serialized operation, immediately before applying.
      if (current.pc.signalingState !== 'have-local-offer') {
        voiceDebug(peerId, 'respuesta obsoleta ignorada', { estado: current.pc.signalingState });
        return;
      }
      await current.pc.setRemoteDescription({ type: 'answer', sdp });
      current.ignoreOffer = false;
      await flushCandidates(peerId, current);
      voiceDebug(peerId, 'respuesta remota aplicada');
    });
  }

  async function offerPeer(peerId: number, mode: PeerMode, iceRestart = false): Promise<void> {
    await enqueuePeer(peerId, mode, async session => {
      const { pc } = session;
      if (session.makingOffer || pc.signalingState !== 'stable') {
        voiceDebug(peerId, 'oferta duplicada omitida', { estado: pc.signalingState });
        session.negotiationPending = true;
        return;
      }
      session.makingOffer = true;
      session.negotiationPending = false;
      try {
        const offer = await pc.createOffer({ iceRestart });
        if (pc.signalingState !== 'stable') {
          voiceDebug(peerId, 'oferta obsoleta omitida', { estado: pc.signalingState });
          session.negotiationPending = true;
          return;
        }
        await pc.setLocalDescription(offer);
        if (iceRestart) {
          session.restarts += 1;
          session.restartPending = false;
          voiceDebug(peerId, 'reiniciando ICE', { intento: session.restarts, maximo: 2 });
        }
        sendWS({
          type: mode === 'dm' ? 'dm:call-offer' : 'voice:offer',
          targetUserId: peerId, sdp: pc.localDescription?.sdp,
        });
        voiceDebug(peerId, 'oferta local enviada', { iceRestart });
      } finally {
        session.makingOffer = false;
      }
    });
  }

  function requestNegotiation(peerId: number, mode: PeerMode) {
    const session = sessionsRef.current.get(peerId);
    if (!session) return;
    if (session.negotiationPending) return;
    session.negotiationPending = true;
    if (!session.makingOffer && session.pc.signalingState === 'stable') {
      void offerPeer(peerId, mode);
    }
  }

  function replaceScreenAudioTrack(
    peerId: number,
    sender: RTCRtpSender,
    track: MediaStreamTrack | null,
    generation: number,
    isCurrent: () => boolean,
  ): Promise<void> {
    return enqueueCurrentPeerTrackOperation(
      screenAudioOperationsRef.current,
      peerId,
      generation,
      () => screenAudioGenerationRef.current,
      () => isCurrent() && (!track || track.readyState === 'live'),
      () => sender.replaceTrack(track),
    );
  }

  async function stopScreenAudio(
    expectedScreen: MediaStream,
    endedTrack: MediaStreamTrack,
    generation: number,
  ) {
    if (screenCleaningRef.current || screenStreamRef.current !== expectedScreen ||
        screenAudioGenerationRef.current !== generation) return;
    await Promise.all([...screenAudioSendersRef.current.entries()].map(async ([peerId, sender]) => {
      try {
        await replaceScreenAudioTrack(
          peerId, sender, null, generation,
          () => screenStreamRef.current === expectedScreen &&
            endedTrack.readyState === 'ended',
        );
      } catch (error) {
        console.error(`[voz][par ${peerId}] No se pudo retirar el audio de pantalla`, error);
      }
    }));
    if (screenCleaningRef.current || screenStreamRef.current !== expectedScreen ||
        screenAudioGenerationRef.current !== generation) return;
    if (mountedRef.current) {
      setScreenAudioAvailable(false);
      setScreenShareNotice('El audio de pantalla terminó; se sigue compartiendo vídeo sin sonido.');
    }
    voiceDebug(currentUserId, 'pista de audio de pantalla finalizada; micrófono intacto');
  }

  async function cleanupScreenShare(stopTracks = true) {
    if (screenCleaningRef.current) return;
    screenCleaningRef.current = true;
    try {
      screenOperationRef.current += 1;
      const cleanupGeneration = ++screenAudioGenerationRef.current;
      const stream = screenStreamRef.current;
      screenStreamRef.current = null;
      screenShareCommittedRef.current = false;
      screenStartingRef.current = false;
      if (mountedRef.current) {
        setScreenStream(null);
        setIsScreenSharing(false);
        setIsScreenShareStarting(false);
        setScreenAudioAvailable(false);
        setScreenShareNotice(null);
      }
      const restorations: Promise<void>[] = [];
      for (const [peerId, sender] of screenSendersRef.current) {
        restorations.push(sender.replaceTrack(null).catch(error => {
          console.error(`[voz][par ${peerId}] No se pudo retirar la pista de pantalla`, error);
        }));
      }
      for (const [peerId, sender] of screenAudioSendersRef.current) {
        restorations.push(replaceScreenAudioTrack(
          peerId, sender, null, cleanupGeneration,
          () => screenStreamRef.current !== stream,
        ).catch(error => {
          console.error(`[voz][par ${peerId}] No se pudo retirar el audio de pantalla`, error);
        }));
      }
      await Promise.all(restorations);
      if (stopTracks) stream?.getTracks().forEach(track => track.stop());
      if (stream) voiceDebug(currentUserId, 'compartir pantalla finalizado');
    } finally {
      screenCleaningRef.current = false;
    }
  }

  function closePeerConnection(peerId: number) {
    const session = sessionsRef.current.get(peerId);
    if (!session) return;
    sessionsRef.current.delete(peerId);
    peerConnections.current.delete(peerId);
    session.candidates.length = 0;
    session.pc.close();
    voiceDebug(peerId, 'par cerrado', {
      locales: session.localCandidates, remotos: session.remoteCandidates,
      puestosEnCola: session.queuedCandidates, reinicios: session.restarts,
    });
    if (mountedRef.current) setRemoteStreams(prev => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
    screenSendersRef.current.delete(peerId);
    cameraSendersRef.current.delete(peerId);
    microphoneSendersRef.current.delete(peerId);
    screenAudioSendersRef.current.delete(peerId);
    screenAudioOperationsRef.current.delete(peerId);
    remoteCompositeStreamsRef.current.delete(peerId);
    remoteAudioStreamRolesRef.current.delete(peerId);
    if (mountedRef.current) setRemoteAudioTracks(prev => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
    pendingRemoteVideoTracksRef.current.delete(peerId);
    if (mountedRef.current) setRemoteScreenStreams(prev => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  }

  const sendWS = useCallback((msg: object) => {
    send(msg);
  }, [send]);

  // ── Local media ───────────────────────────────────────────────────────────

  const startLocalMedia = useCallback(async (withVideo = false): Promise<MediaStream | null> => {
    if (localStreamRef.current) return localStreamRef.current;
    if (mediaPromiseRef.current) return mediaPromiseRef.current;
    const generation = mediaGenerationRef.current;
    const pending = (async () => {
      try {
      const latestSettings = settingsRef.current;
      const constraints = callMediaConstraints(latestSettings.audioInputId,
        latestSettings.videoQuality ?? 'medium', withVideo, latestSettings);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (!mountedRef.current || generation !== mediaGenerationRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return null;
      }
      localStreamRef.current = stream;
      sessionsRef.current.forEach((session, peerId) => {
        stream.getTracks().forEach(track => {
          const senderMap = track.kind === 'audio' ? microphoneSendersRef : cameraSendersRef;
          if (senderMap.current.has(peerId)) return;
          const outgoing = track.kind === 'audio' ? (outgoingMicTrack() ?? track) : track;
          senderMap.current.set(peerId, session.pc.addTrack(outgoing, stream));
          requestNegotiation(peerId, session.mode);
        });
      });
      setLocalStream(stream);
      setIsMuted(false);
      startSpeakingDetection(stream);
      return stream;
      } catch (err) {
        console.error('[voz] No se pudo obtener el micrófono', err);
        return null;
      }
    })();
    mediaPromiseRef.current = pending;
    try { return await pending; }
    finally { if (mediaPromiseRef.current === pending) mediaPromiseRef.current = null; }
  }, [settings.audioInputId, settings.videoQuality, settings.echoCancellation,
    settings.noiseSuppression, settings.autoGainControl]);

  useEffect(() => {
    const rawTrack = localStream?.getAudioTracks()[0];
    if (!rawTrack) return;
    const operation = ++processorOperationRef.current;
    const enabled = settings.advancedNoiseSuppression !== false;
    processorTaskRef.current = processorTaskRef.current.catch(() => {}).then(async () => {
      if (localStreamRef.current?.getAudioTracks()[0] !== rawTrack || operation !== processorOperationRef.current) return;
      if (!enabled) {
        const routed = await routeMicrophone(rawTrack);
        if (operation !== processorOperationRef.current) return;
        if (routed) {
          retireMicrophonePath(processorRef.current);
          processorRef.current = null;
        }
        return;
      }
      if (!processorRef.current) {
        try {
          let created: MicrophoneProcessor | null = null;
          let failureReason: string | null = null;
          const processor = await createMicrophoneProcessor(rawTrack, reason => {
            failureReason = reason;
            console.warn(`[voz] RNNoise no disponible: ${reason}. Se conserva el micrófono nativo.`);
            if (!created || processorRef.current !== created) return;
            processorOperationRef.current += 1;
            void routeMicrophone(rawTrack).finally(() => {
              if (processorRef.current === created) {
                processorRef.current = null;
                retireMicrophonePath(created);
              }
            });
          });
          created = processor;
          if (failureReason) {
            processor.stop();
            return;
          }
          if (operation !== processorOperationRef.current ||
              localStreamRef.current?.getAudioTracks()[0] !== rawTrack) {
            processor.stop();
            return;
          }
          processorRef.current = processor;
        } catch (error) {
          if (operation === processorOperationRef.current) {
            console.warn('[voz] RNNoise no disponible; se conserva el procesado nativo', error);
          }
          return;
        }
      }
      if (processorRef.current) await routeMicrophone(processorRef.current.track);
    }).catch(error => console.warn('[voz] No se pudo reconfigurar RNNoise; el micrófono sigue activo', error));
  }, [localStream, settings.advancedNoiseSuppression]);

  useEffect(() => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    const requested = {
      noiseSuppression: settings.noiseSuppression ?? true,
      echoCancellation: settings.echoCancellation ?? true,
      autoGainControl: settings.autoGainControl ?? true,
    };
    const epoch = ++nativeSettingsEpochRef.current;
    const attemptKey = `${mediaGenerationRef.current}:${settings.audioInputId ?? ''}:${JSON.stringify(requested)}`;
    if (nativeRecaptureAttemptRef.current === attemptKey) return;
    void (async () => {
      const next = await updateNativeMicrophoneTrack(track, settings.audioInputId, requested);
      if (next === track) return;
      nativeRecaptureAttemptRef.current = attemptKey;
      await processorTaskRef.current.catch(() => {});
      const stream = localStreamRef.current;
      if (epoch !== nativeSettingsEpochRef.current || stream?.getAudioTracks()[0] !== track) {
        next.stop();
        return;
      }
      next.enabled = track.enabled;
      stream.addTrack(next);
      // Keep the old processor and raw capture alive until the new track is
      // actually routed. Neither an existing mixer sender nor an SDP changes.
      let routed = false;
      try { routed = await routeMicrophone(next); }
      catch (error) { console.warn('[voz] No se pudo cambiar la fuente del micrófono', error); }
      if (!routed) {
        const restored = await routeMicrophone(processorRef.current?.track ?? track);
        if (restored) {
          stream.removeTrack(next);
          retireMicrophonePath(null, next);
        } else {
          // Keep both live if a sender rejected replacement in either
          // direction; stopping either track could mute some participants.
          console.error('[voz] Algunos participantes conservan una pista distinta; ambas siguen activas');
        }
        return;
      }
      processorOperationRef.current += 1;
      retireMicrophonePath(processorRef.current, track);
      processorRef.current = null;
      stream.removeTrack(track);
      startSpeakingDetection(stream);
      setLocalStream(new MediaStream(stream.getTracks()));
    })().catch(error => console.warn('[voz] No se pudieron actualizar los ajustes nativos; sigue el micrófono anterior', error));
  }, [localStream, settings.audioInputId, settings.noiseSuppression, settings.echoCancellation, settings.autoGainControl]);

  const startSpeakingDetection = (stream: MediaStream) => {
    safeCloseAudioContext(audioContextRef.current);
    audioContextRef.current = null;
    try {
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      if (speakingIntervalRef.current) clearInterval(speakingIntervalRef.current);
      let quietSamples = 0;
      speakingIntervalRef.current = setInterval(() => {
        const buf = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        if (avg > 15) {
          quietSamples = 0;
          if (speakerRef.current !== currentUserId) {
            speakerRef.current = currentUserId;
            setActiveSpeakerId(currentUserId);
          }
        } else if (++quietSamples >= 5 && speakerRef.current !== null) {
          speakerRef.current = null;
          setActiveSpeakerId(null);
        }
      }, 200);
    } catch (error) {
      console.warn('[voz] Detector de actividad no disponible', error);
    }
  };

  const stopLocalMedia = useCallback(() => {
    nativeSettingsEpochRef.current += 1;
    nativeRecaptureAttemptRef.current = '';
    processorOperationRef.current += 1;
    processorRef.current?.stop();
    processorRef.current = null;
    activeMicTrackRef.current = null;
    cameraOperationRef.current += 1;
    mediaGenerationRef.current += 1;
    mediaPromiseRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setIsCameraOn(false);
    if (speakingIntervalRef.current) clearInterval(speakingIntervalRef.current);
    speakingIntervalRef.current = null;
    safeCloseAudioContext(audioContextRef.current);
    audioContextRef.current = null;
    speakerRef.current = null;
    if (mountedRef.current) setActiveSpeakerId(null);
  }, []);

  // ── DM call offer ──────────────────────────────────────────────────────────

  const startDmCallOffer = async (peerId: number): Promise<boolean> => {
    const stream = await startLocalMedia(false);
    if (!stream) return false;
    if (dmCallUserIdRef.current !== peerId) {
      if (activeVoiceChannelIdRef.current === null && sessionsRef.current.size === 0) stopLocalMedia();
      return false;
    }
    await offerPeer(peerId, 'dm');
    return true;
  };

  // ── Cleanup ────────────────────────────────────────────────────────────────

  const cleanupAll = useCallback(() => {
    cameraOperationRef.current += 1;
    for (const peerId of [...sessionsRef.current.keys()]) closePeerConnection(peerId);
    void cleanupScreenShare();
    stopLocalMedia();
    if (mountedRef.current) {
      setRemoteStreams(new Map());
      setRemoteScreenStreams(new Map());
    }
  }, [stopLocalMedia]);

  function cleanupMode(mode: PeerMode) {
    for (const [peerId, session] of sessionsRef.current) {
      if (session.mode === mode) closePeerConnection(peerId);
    }
    if (sessionsRef.current.size === 0) stopLocalMedia();
  }

  useEffect(() => {
    mountedRef.current = true;
    const pageHide = () => {
      lifecycleRef.current += 1;
      const channelId = activeVoiceChannelIdRef.current;
      if (channelId !== null) {
        sendWS({ type: 'voice:unbind', channelId });
        activeVoiceChannelIdRef.current = null;
      }
      if (dmCallUserIdRef.current) {
        sendWS({ type: 'dm:call-end', targetUserId: dmCallUserIdRef.current });
      }
      cleanupAll();
    };
    window.addEventListener('pagehide', pageHide);
    return () => {
      pageHide();
      mountedRef.current = false;
      window.removeEventListener('pagehide', pageHide);
      voiceSubscriptionReleaseRef.current?.();
      voiceSubscriptionReleaseRef.current = null;
    };
  }, [cleanupAll, sendWS]);

  // ── Voice channel controls ─────────────────────────────────────────────────

  const leaveVoiceChannel = useCallback(async () => {
    const chId = activeVoiceChannelIdRef.current;
    if (chId === null || leaveInProgressRef.current) return;
    leaveInProgressRef.current = true;
    lifecycleRef.current += 1;
    activeVoiceChannelIdRef.current = null;
    sendWS({ type: 'voice:unbind', channelId: chId });
    voiceSubscriptionReleaseRef.current?.();
    voiceSubscriptionReleaseRef.current = null;
    cleanupMode('voice');
    if (dmCallUserIdRef.current === null && incomingCallerIdRef.current === null) {
      void cleanupScreenShare();
    }
    setIsInVoiceChannel(false);
    setActiveVoiceChannelId(null);
    setVoiceMembers([]);
    playVoiceLeaveSound();
    try {
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
      const response = await csrfFetch(`${baseUrl}/api/channels/${chId}/voice/leave`, {
        method: 'POST', credentials: 'include',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error(`[voz] Error al abandonar el canal ${chId}`, error);
      throw error;
    } finally {
      leaveInProgressRef.current = false;
    }
  }, [sendWS, stopLocalMedia]);

  const joinVoiceChannel = useCallback(async (channelId: number, _currentMembers: VoiceMember[]) => {
    if (joinInProgressRef.current || leaveInProgressRef.current ||
        activeVoiceChannelIdRef.current === channelId) {
      voiceDebug(channelId, 'entrada repetida omitida');
      return;
    }
    joinInProgressRef.current = true;
    try {
      if (activeVoiceChannelIdRef.current !== null) await leaveVoiceChannel();
      const generation = ++lifecycleRef.current;
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await csrfFetch(`${baseUrl}/api/channels/${channelId}/voice/join`, {
        method: 'POST', credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const members: VoiceMember[] = await res.json();
      if (!mountedRef.current || generation !== lifecycleRef.current) return;
      activeVoiceChannelIdRef.current = channelId;
      setActiveVoiceChannelId(channelId);
      setIsInVoiceChannel(true);
      setVoiceMembers(members.filter(m => m.userId !== currentUserId));
      voiceSubscriptionReleaseRef.current = retainChannel(`channel:${channelId}`);
      sendWS({ type: 'voice:bind', channelId });
      playVoiceJoinSound();
      const stream = await startLocalMedia(false);
      if (!stream || generation !== lifecycleRef.current) {
        if (!stream && generation === lifecycleRef.current) await leaveVoiceChannel();
        if (generation !== lifecycleRef.current && sessionsRef.current.size === 0) stopLocalMedia();
        return;
      }
      // The server's voice:bound acknowledgement / member_join events initiate
      // offers only to peers with an actual bound WebSocket connection.
    } catch (error) {
      console.error(`[voz] Entrada al canal ${channelId} fallida`, error);
    } finally {
      joinInProgressRef.current = false;
    }
  }, [currentUserId, leaveVoiceChannel, retainChannel, startLocalMedia, stopLocalMedia]);

  // ── DM call controls ───────────────────────────────────────────────────────

  const callUser = useCallback(async (targetUserId: number, callerName: string, callerAvatar?: string | null) => {
    if (callState !== 'idle') return;
    dmCallUserIdRef.current = targetUserId;
    setCallState('calling');
    setDmCallUserId(targetUserId);
    sendWS({
      type: 'dm:call-invite',
      recipientId: targetUserId,
      callerName,
      callerAvatar,
    });
  }, [callState, sendWS]);

  const acceptCall = useCallback(async () => {
    if (!incomingCall) return;
    const callerId = incomingCall.callerId;
    dmCallUserIdRef.current = callerId;
    if (!await startLocalMedia(false)) {
      dmCallUserIdRef.current = null;
      return;
    }
    if (dmCallUserIdRef.current !== callerId || incomingCallerIdRef.current !== callerId) {
      if (activeVoiceChannelIdRef.current === null && sessionsRef.current.size === 0) stopLocalMedia();
      return;
    }
    incomingCallerIdRef.current = null;
    setIncomingCall(null);
    setCallState('connected');
    setDmCallUserId(callerId);
    sendWS({ type: 'dm:call-answer', callerId });
  }, [incomingCall, sendWS, startLocalMedia]);

  const rejectCall = useCallback(() => {
    if (!incomingCall) return;
    cameraOperationRef.current += 1;
    sendWS({ type: 'dm:call-reject', callerId: incomingCall.callerId });
    dmCallUserIdRef.current = null;
    incomingCallerIdRef.current = null;
    setIncomingCall(null);
    setCallState('idle');
  }, [incomingCall, sendWS]);

  const endCall = useCallback(async () => {
    cameraOperationRef.current += 1;
    const peerId = dmCallUserIdRef.current;
    dmCallUserIdRef.current = null;
    incomingCallerIdRef.current = null;
    if (peerId) {
      sendWS({ type: 'dm:call-end', targetUserId: peerId });
      closePeerConnection(peerId);
    }
    if (activeVoiceChannelIdRef.current === null) {
      void cleanupScreenShare();
      stopLocalMedia();
    }
    setCallState('idle');
    setDmCallUserId(null);
    setRemoteStreams(new Map());
  }, [sendWS, stopLocalMedia]);

  // ── Media controls ─────────────────────────────────────────────────────────

  const toggleMute = useCallback(() => {
    const newMuted = !isMuted;
    // Toggle the actual audio track if we have a stream
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !newMuted; // enabled=true means unmuted
      }
    }
    // Always update state so the UI reflects the change even without mic access
    setIsMuted(newMuted);
  }, [isMuted]);

  const toggleCamera = useCallback(async () => {
    if (isCameraOn) {
      cameraOperationRef.current += 1;
      const tracks = localStreamRef.current?.getVideoTracks() ?? [];
      await Promise.all([...cameraSendersRef.current.entries()].map(async ([peerId, sender]) => {
        try { await sender.replaceTrack(null); }
        catch (error) { console.error(`[voz][par ${peerId}] No se pudo pausar la cámara`, error); }
      }));
      tracks.forEach(track => {
        localStreamRef.current?.removeTrack(track);
        track.stop();
      });
      setIsCameraOn(false);
    } else {
      const operation = ++cameraOperationRef.current;
      const hasActiveCall = () => activeVoiceChannelIdRef.current !== null ||
        dmCallUserIdRef.current !== null;
      const isCurrent = () => mountedRef.current &&
        operation === cameraOperationRef.current && hasActiveCall();
      if (!hasActiveCall()) return;
      let videoTrack: MediaStreamTrack | undefined;
      const changedSenders: RTCRtpSender[] = [];
      try {
        if (!localStreamRef.current && !await startLocalMedia(false)) return;
        if (!isCurrent()) return;
        const videoConstraints = videoConstraintsFromQuality(settings.videoQuality ?? 'medium');
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        videoTrack = videoStream.getVideoTracks()[0];
        if (!videoTrack) throw new Error('La cámara no devolvió una pista de vídeo');
        if (!isCurrent() || !localStreamRef.current) {
          videoTrack.stop();
          return;
        }
        localStreamRef.current.addTrack(videoTrack);
        for (const [peerId, session] of sessionsRef.current) {
          if (!isCurrent()) throw new DOMException('Activación de cámara cancelada', 'AbortError');
          const existing = cameraSendersRef.current.get(peerId);
          if (existing) {
            await existing.replaceTrack(videoTrack);
            changedSenders.push(existing);
            if (!isCurrent()) throw new DOMException('Activación de cámara cancelada', 'AbortError');
          } else {
            const sender = session.pc.addTrack(videoTrack, localStreamRef.current);
            cameraSendersRef.current.set(peerId, sender);
            changedSenders.push(sender);
            requestNegotiation(peerId, session.mode);
          }
        }
        if (!isCurrent()) throw new DOMException('Activación de cámara cancelada', 'AbortError');
        setIsCameraOn(true);
      } catch (err) {
        await Promise.all(changedSenders.map(sender => sender.replaceTrack(null).catch(error => {
          console.error('[voz] No se pudo revertir la activación de cámara', error);
        })));
        if (videoTrack) {
          localStreamRef.current?.removeTrack(videoTrack);
          videoTrack.stop();
        }
        if (operation !== cameraOperationRef.current || !mountedRef.current) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        console.error('[voz] No se pudo iniciar la cámara', err);
      }
    }
  }, [isCameraOn, settings.videoQuality, startLocalMedia]);

  const toggleScreenShare = useCallback(async () => {
    if (screenCleaningRef.current) return;
    if (screenStartingRef.current) {
      await cleanupScreenShare();
      return;
    }
    if (screenStreamRef.current) {
      await cleanupScreenShare();
      return;
    }

    const operation = ++screenOperationRef.current;
    const audioGeneration = ++screenAudioGenerationRef.current;
    const lifecycle = lifecycleRef.current;
    screenStartingRef.current = true;
    screenShareCommittedRef.current = false;
    setIsScreenShareStarting(true);
    setScreenAudioAvailable(false);
    setScreenShareNotice(null);
    voiceDebug(currentUserId, 'selector de pantalla abierto');
    let acquired: MediaStream | null = null;
    try {
      acquired = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!mountedRef.current || operation !== screenOperationRef.current ||
          lifecycle !== lifecycleRef.current) {
        acquired.getTracks().forEach(track => track.stop());
        if (operation === screenOperationRef.current) {
          screenStartingRef.current = false;
          setIsScreenShareStarting(false);
        }
        return;
      }
      const screenTrack = acquired.getVideoTracks()[0];
      if (!screenTrack) throw new Error('El selector no devolvió una pista de vídeo');
      screenStreamRef.current = acquired;
      setScreenStream(acquired);
      const ensureCurrent = () => {
        if (!mountedRef.current || operation !== screenOperationRef.current ||
            lifecycle !== lifecycleRef.current || screenStreamRef.current !== acquired ||
            audioGeneration !== screenAudioGenerationRef.current) {
          throw new DOMException('Compartir pantalla cancelado', 'AbortError');
        }
      };
      screenTrack.onended = () => { void cleanupScreenShare(); };

      let audioReady = false;
      const displayAudioTracks = acquired.getAudioTracks();
      displayAudioTracks.forEach(track => {
        track.onended = () => { void stopScreenAudio(acquired!, track, audioGeneration); };
      });
      const displayAudioTrack = displayAudioTracks.find(track => track.readyState === 'live');
      if (displayAudioTrack) {
        try {
          const replaced: Array<{ sender: RTCRtpSender; previousTrack: MediaStreamTrack | null; peerId: number }> = [];
          try {
            for (const [peerId, session] of sessionsRef.current) {
              ensureCurrent();
              if (displayAudioTrack.readyState !== 'live') break;
              let sender = screenAudioSendersRef.current.get(peerId);
              if (!sender) {
                sender = session.pc.addTrack(displayAudioTrack, acquired);
                screenAudioSendersRef.current.set(peerId, sender);
                replaced.push({ sender, previousTrack: null, peerId });
                requestNegotiation(peerId, session.mode);
              } else {
                const previousTrack = sender.track;
                replaced.push({ sender, previousTrack, peerId });
                await replaceScreenAudioTrack(
                  peerId, sender, displayAudioTrack, audioGeneration,
                  () => screenStreamRef.current === acquired,
                );
                ensureCurrent();
              }
            }
            audioReady = displayAudioTrack.readyState === 'live';
          } catch (error) {
            await Promise.all(replaced.map(item => replaceScreenAudioTrack(
              item.peerId,
              item.sender,
              item.previousTrack?.readyState === 'live' ? item.previousTrack : null,
              audioGeneration,
              () => screenStreamRef.current === acquired,
            ).catch(rollbackError => {
              console.error(`[voz][par ${item.peerId}] Error al revertir el audio de pantalla`, rollbackError);
            })));
            throw error;
          }
        } catch (error) {
          if ((error as { name?: string })?.name === 'AbortError') throw error;
          console.error('[voz] No se pudo enviar el audio de pantalla como pista separada', error);
          setScreenShareNotice('La pantalla se compartirá sin sonido.');
        }
      } else {
        setScreenShareNotice('El navegador no proporcionó audio de pantalla; se compartirá sin sonido.');
      }

      if (audioReady) {
        setScreenAudioAvailable(true);
        setScreenShareNotice(null);
      }

      const changedSenders: RTCRtpSender[] = [];
      try {
        for (const [peerId, session] of sessionsRef.current) {
          const sender = screenSendersRef.current.get(peerId);
          if (sender) {
            await sender.replaceTrack(screenTrack);
            changedSenders.push(sender);
            ensureCurrent();
          } else {
            const newSender = session.pc.addTrack(screenTrack, acquired);
            screenSendersRef.current.set(peerId, newSender);
            requestNegotiation(peerId, session.mode);
          }
        }
      } catch (error) {
        await Promise.all(changedSenders.map(sender => sender.replaceTrack(null).catch(() => undefined)));
        throw error;
      }

      ensureCurrent();
      if (screenTrack.readyState === 'ended') {
        await cleanupScreenShare();
        return;
      }
      if (audioReady && displayAudioTrack?.readyState === 'ended') {
        await stopScreenAudio(acquired, displayAudioTrack, audioGeneration);
        audioReady = false;
      }
      ensureCurrent();
      screenShareCommittedRef.current = true;
      const committedTracks = getLiveScreenTracks(acquired, true);
      if (committedTracks) {
        for (const [peerId, session] of sessionsRef.current) {
          if (committedTracks.audio && !screenAudioSendersRef.current.has(peerId)) {
            const sender = session.pc.addTrack(committedTracks.audio, acquired);
            screenAudioSendersRef.current.set(peerId, sender);
            requestNegotiation(peerId, session.mode);
          }
          if (committedTracks.video && !screenSendersRef.current.has(peerId)) {
            const sender = session.pc.addTrack(committedTracks.video, acquired);
            screenSendersRef.current.set(peerId, sender);
            requestNegotiation(peerId, session.mode);
          }
        }
      }
      setIsScreenSharing(true);
      setIsScreenShareStarting(false);
      screenStartingRef.current = false;
      voiceDebug(currentUserId, 'compartir pantalla iniciado', { audio: audioReady });
    } catch (error) {
      const currentOperation = operation === screenOperationRef.current;
      const ownsStream = !!acquired && screenStreamRef.current === acquired;
      if (ownsStream) await cleanupScreenShare();
      else if (acquired) acquired.getTracks().forEach(track => track.stop());
      if (!currentOperation) return;
      screenStartingRef.current = false;
      if (mountedRef.current) setIsScreenShareStarting(false);
      const name = (error as { name?: string })?.name;
      if (name === 'AbortError' || name === 'NotAllowedError') {
        voiceDebug(currentUserId, 'selector de pantalla cancelado');
        return;
      }
      console.error('[voz] No se pudo compartir la pantalla', error);
      if (mountedRef.current) setScreenShareNotice('No se pudo iniciar el compartir pantalla.');
    }
  }, []);

  return {
    // State
    localStream,
    remoteStreams,
    remoteAudioTracks,
    activeSpeakerId,
    isMuted,
    isCameraOn,
    isScreenSharing,
    screenStream,
    remoteScreenStreams,
    screenAudioAvailable,
    isScreenShareStarting,
    screenShareNotice,
    isInVoiceChannel,
    activeVoiceChannelId,
    voiceMembers,
    callState,
    incomingCall,
    dmCallUserId,
    // Voice channel
    joinVoiceChannel,
    leaveVoiceChannel,
    // DM call
    callUser,
    acceptCall,
    rejectCall,
    endCall,
    // Media
    toggleMute,
    toggleCamera,
    toggleScreenShare,
  };
}
