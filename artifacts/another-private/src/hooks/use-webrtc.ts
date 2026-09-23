import { useEffect, useRef, useState, useCallback } from 'react';
import { safeCloseAudioContext, videoConstraintsFromQuality, type VideoQuality } from '@/lib/settings-utils';
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
};

export interface VoiceMember {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  status: string;
}

export interface AudioVideoSettings {
  audioInputId?: string;
  audioOutputId?: string;
  volume?: number;
  videoQuality?: VideoQuality;
}

type CallState = 'idle' | 'calling' | 'ringing' | 'connected';

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
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const speakingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const activeVoiceChannelIdRef = useRef<number | null>(null);
  const voiceSubscriptionReleaseRef = useRef<(() => void) | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<number, MediaStream>>(new Map());
  const [activeSpeakerId, setActiveSpeakerId] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
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
        closePeerConnection(msg.data.fromUserId);
        dmCallUserIdRef.current = null;
        incomingCallerIdRef.current = null;
        setIncomingCall(null);
        setCallState('idle');
        setDmCallUserId(null);
        if (activeVoiceChannelIdRef.current === null) stopLocalMedia();
        break;
      }

      case 'dm:call-end': {
        if (dmCallUserIdRef.current !== msg.data.fromUserId &&
            incomingCallerIdRef.current !== msg.data.fromUserId) break;
        closePeerConnection(msg.data.fromUserId);
        dmCallUserIdRef.current = null;
        incomingCallerIdRef.current = null;
        setIncomingCall(null);
        setCallState('idle');
        setDmCallUserId(null);
        setRemoteStreams(new Map());
        if (activeVoiceChannelIdRef.current === null) stopLocalMedia();
        break;
      }
      }
    } catch (error) {
      console.error(`[voz][par ${Number.isFinite(peerId) ? peerId : 'desconocido'}] Error en ${msg.type}`, error);
    }
  }, [currentUserId]);

  useRealtimeMessages(SIGNALING_MESSAGE_TYPES, handleSignalingMessage);

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
      remoteCandidates: 0, queuedCandidates: 0,
    };
    sessionsRef.current.set(peerId, session);
    peerConnections.current.set(peerId, pc);
    voiceDebug(peerId, 'par creado', { mode, rol: currentUserId > peerId ? 'cortés' : 'firme' });

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));
    }
    pc.onsignalingstatechange = () => {
      voiceDebug(peerId, 'estado señalización', { estado: pc.signalingState });
      if (pc.signalingState === 'stable' && session.restartPending) {
        void offerPeer(peerId, mode, true);
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
      const stream = event.streams[0];
      if (!stream || sessionsRef.current.get(peerId) !== session) return;
      voiceDebug(peerId, 'flujo remoto recibido', { pistas: stream.getTracks().map(t => t.kind) });
      setRemoteStreams(prev => {
        if (prev.get(peerId) === stream) return prev;
        const next = new Map(prev);
        next.set(peerId, stream);
        return next;
      });
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
        return;
      }
      session.makingOffer = true;
      try {
        const offer = await pc.createOffer({ iceRestart });
        if (pc.signalingState !== 'stable') {
          voiceDebug(peerId, 'oferta obsoleta omitida', { estado: pc.signalingState });
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
      const constraints: MediaStreamConstraints = {
        audio: settings.audioInputId
          ? { deviceId: { exact: settings.audioInputId } }
          : true,
        video: withVideo ? videoConstraintsFromQuality(settings.videoQuality ?? 'medium') : false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (!mountedRef.current || generation !== mediaGenerationRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return null;
      }
      localStreamRef.current = stream;
      sessionsRef.current.forEach(session => {
        stream.getTracks().forEach(track => {
          if (!session.pc.getSenders().some(sender => sender.track === track)) {
            session.pc.addTrack(track, stream);
          }
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
  }, [settings.audioInputId, settings.videoQuality]);

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
    mediaGenerationRef.current += 1;
    mediaPromiseRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
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
    for (const peerId of [...sessionsRef.current.keys()]) closePeerConnection(peerId);
    stopLocalMedia();
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    if (mountedRef.current) setRemoteStreams(new Map());
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
    sendWS({ type: 'dm:call-reject', callerId: incomingCall.callerId });
    dmCallUserIdRef.current = null;
    incomingCallerIdRef.current = null;
    setIncomingCall(null);
    setCallState('idle');
  }, [incomingCall, sendWS]);

  const endCall = useCallback(async () => {
    const peerId = dmCallUserIdRef.current;
    dmCallUserIdRef.current = null;
    incomingCallerIdRef.current = null;
    if (peerId) {
      sendWS({ type: 'dm:call-end', targetUserId: peerId });
      closePeerConnection(peerId);
    }
    if (activeVoiceChannelIdRef.current === null) stopLocalMedia();
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
      localStreamRef.current?.getVideoTracks().forEach(t => { t.stop(); });
      if (localStreamRef.current) {
        const videoTracks = localStreamRef.current.getVideoTracks();
        videoTracks.forEach(t => localStreamRef.current?.removeTrack(t));
      }
      peerConnections.current.forEach(pc => {
        pc.getSenders().filter(s => s.track?.kind === 'video').forEach(s => pc.removeTrack(s));
      });
      setIsCameraOn(false);
    } else {
      try {
        const videoConstraints = videoConstraintsFromQuality(settings.videoQuality ?? 'medium');
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const videoTrack = videoStream.getVideoTracks()[0];
        if (localStreamRef.current) {
          localStreamRef.current.addTrack(videoTrack);
        }
        peerConnections.current.forEach(pc => {
          pc.addTrack(videoTrack, localStreamRef.current!);
        });
        setIsCameraOn(true);
      } catch (err) {
        console.error('Failed to start camera', err);
      }
    }
  }, [isCameraOn]);

  const toggleScreenShare = useCallback(async () => {
    if (isScreenSharing) {
      screenStreamRef.current?.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
      setIsScreenSharing(false);
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];

        peerConnections.current.forEach(pc => {
          const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (videoSender) {
            videoSender.replaceTrack(screenTrack);
          } else {
            pc.addTrack(screenTrack, screenStream);
          }
        });

        screenTrack.onended = () => {
          setIsScreenSharing(false);
          screenStreamRef.current = null;
        };

        setIsScreenSharing(true);
      } catch (err) {
        console.error('Failed to share screen', err);
      }
    }
  }, [isScreenSharing]);

  return {
    // State
    localStream,
    remoteStreams,
    activeSpeakerId,
    isMuted,
    isCameraOn,
    isScreenSharing,
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
