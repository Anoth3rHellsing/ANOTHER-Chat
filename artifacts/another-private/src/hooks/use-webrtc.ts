import { useEffect, useRef, useState, useCallback } from 'react';
import { safeCloseAudioContext, videoConstraintsFromQuality, type VideoQuality } from '@/lib/settings-utils';
import { playVoiceJoinSound, playVoiceLeaveSound } from '@/lib/voice-sounds';
import { csrfFetch } from '@workspace/api-client-react';
import {
  useRealtimeMessages,
  useRealtimeTransport,
} from '@/providers/realtime-transport';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Open Relay TURN server — no registration required
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

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

  // ── Signaling handler ──────────────────────────────────────────────────────

  const handleSignalingMessage = useCallback(async (msg: any) => {
    switch (msg.type) {
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
        const { fromUserId, sdp } = msg.data;
        const pc = getOrCreatePC(fromUserId);
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWS({ type: 'voice:answer', targetUserId: fromUserId, sdp: answer.sdp });
        break;
      }

      case 'voice:answer': {
        const { fromUserId, sdp } = msg.data;
        const pc = peerConnections.current.get(fromUserId);
        if (pc && pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        }
        break;
      }

      case 'voice:ice-candidate': {
        const { fromUserId, candidate } = msg.data;
        const pc = peerConnections.current.get(fromUserId);
        if (pc && candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
        }
        break;
      }

      // DM call signaling
      case 'dm:call-invite': {
        const { callerId, callerName, callerAvatar } = msg.data;
        setIncomingCall({ callerId, callerName, callerAvatar });
        setCallState('ringing');
        break;
      }

      case 'dm:call-accepted': {
        const { acceptorId } = msg.data;
        setCallState('connected');
        setDmCallUserId(acceptorId);
        await startDmCallOffer(acceptorId);
        break;
      }

      case 'dm:call-offer': {
        const { fromUserId, sdp } = msg.data;
        const pc = getOrCreatePC(fromUserId);
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWS({ type: 'dm:call-sdp-answer', targetUserId: fromUserId, sdp: answer.sdp });
        setCallState('connected');
        setDmCallUserId(fromUserId);
        break;
      }

      case 'dm:call-sdp-answer': {
        const { fromUserId, sdp } = msg.data;
        const pc = peerConnections.current.get(fromUserId);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        }
        break;
      }

      case 'dm:call-ice-candidate': {
        const { fromUserId, candidate } = msg.data;
        const pc = peerConnections.current.get(fromUserId);
        if (pc && candidate) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
        }
        break;
      }

      case 'dm:call-reject': {
        setIncomingCall(null);
        setCallState('idle');
        setDmCallUserId(null);
        break;
      }

      case 'dm:call-end': {
        closePeerConnection(msg.data.fromUserId);
        setCallState('idle');
        setDmCallUserId(null);
        setRemoteStreams(new Map());
        break;
      }
    }
  }, [currentUserId]);

  useRealtimeMessages(SIGNALING_MESSAGE_TYPES, handleSignalingMessage);

  // ── Peer connection management ──────────────────────────────────────────────

  function getOrCreatePC(peerId: number): RTCPeerConnection {
    if (peerConnections.current.has(peerId)) {
      return peerConnections.current.get(peerId)!;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections.current.set(peerId, pc);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWS({ type: 'voice:ice-candidate', targetUserId: peerId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        setRemoteStreams(prev => {
          const next = new Map(prev);
          next.set(peerId, stream);
          return next;
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        closePeerConnection(peerId);
      }
    };

    return pc;
  }

  function closePeerConnection(peerId: number) {
    const pc = peerConnections.current.get(peerId);
    if (pc) {
      pc.close();
      peerConnections.current.delete(peerId);
    }
    setRemoteStreams(prev => {
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  }

  const sendWS = useCallback((msg: object) => {
    send(msg);
  }, [send]);

  // ── Local media ───────────────────────────────────────────────────────────

  const startLocalMedia = useCallback(async (withVideo = false) => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: settings.audioInputId
          ? { deviceId: { exact: settings.audioInputId } }
          : true,
        video: withVideo
          ? (settings.audioInputId ? { deviceId: settings.audioInputId } : true)
          : false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsMuted(false);
      startSpeakingDetection(stream);
      return stream;
    } catch (err) {
      console.error('Failed to get local media', err);
      return null;
    }
  }, [settings.audioInputId]);

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
      speakingIntervalRef.current = setInterval(() => {
        const buf = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        if (avg > 15) {
          setActiveSpeakerId(currentUserId);
        }
      }, 200);
    } catch {}
  };

  const stopLocalMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    if (speakingIntervalRef.current) clearInterval(speakingIntervalRef.current);
    safeCloseAudioContext(audioContextRef.current);
    audioContextRef.current = null;
  }, []);

  // ── DM call offer ──────────────────────────────────────────────────────────

  const startDmCallOffer = async (peerId: number) => {
    const stream = await startLocalMedia(false);
    if (!stream) return;

    const pc = getOrCreatePC(peerId);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendWS({ type: 'dm:call-ice-candidate', targetUserId: peerId, candidate: event.candidate });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWS({ type: 'dm:call-offer', targetUserId: peerId, sdp: offer.sdp });
  };

  // ── Cleanup ────────────────────────────────────────────────────────────────

  const cleanupAll = useCallback(() => {
    peerConnections.current.forEach(pc => pc.close());
    peerConnections.current.clear();
    stopLocalMedia();
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    setRemoteStreams(new Map());
  }, [stopLocalMedia]);

  useEffect(() => () => {
    const channelId = activeVoiceChannelIdRef.current;
    if (channelId !== null) {
      sendWS({ type: 'voice:unbind', channelId });
    }
    voiceSubscriptionReleaseRef.current?.();
    voiceSubscriptionReleaseRef.current = null;
    cleanupAll();
  }, [cleanupAll, sendWS]);

  // ── Voice channel controls ─────────────────────────────────────────────────

  const joinVoiceChannel = useCallback(async (channelId: number, currentMembers: VoiceMember[]) => {
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    const res = await csrfFetch(`${baseUrl}/api/channels/${channelId}/voice/join`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return;
    const members: VoiceMember[] = await res.json();

    setActiveVoiceChannelId(channelId);
    activeVoiceChannelIdRef.current = channelId;
    setIsInVoiceChannel(true);
    setVoiceMembers(members.filter(m => m.userId !== currentUserId));
    sendWS({ type: 'voice:bind', channelId });

    // Play join sound for ourselves
    playVoiceJoinSound();

    voiceSubscriptionReleaseRef.current?.();
    voiceSubscriptionReleaseRef.current = retainChannel(`channel:${channelId}`);

    const stream = await startLocalMedia(false);
    if (!stream) return;

    // Send offer to each existing member (we are the joiner = offerer)
    for (const member of members) {
      if (member.userId === currentUserId) continue;
      const pc = getOrCreatePC(member.userId);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          sendWS({ type: 'voice:ice-candidate', targetUserId: member.userId, candidate: event.candidate });
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS({ type: 'voice:offer', targetUserId: member.userId, sdp: offer.sdp });
    }
  }, [currentUserId, retainChannel, startLocalMedia]);

  const leaveVoiceChannel = useCallback(async () => {
    if (!activeVoiceChannelId) return;
    const chId = activeVoiceChannelId;

    // Play leave sound for ourselves before clearing state
    playVoiceLeaveSound();

    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
    sendWS({ type: 'voice:unbind', channelId: chId });
    await csrfFetch(`${baseUrl}/api/channels/${chId}/voice/leave`, {
      method: 'POST',
      credentials: 'include',
    });

    peerConnections.current.forEach(pc => pc.close());
    peerConnections.current.clear();
    stopLocalMedia();
    setRemoteStreams(new Map());
    setIsInVoiceChannel(false);
    setActiveVoiceChannelId(null);
    activeVoiceChannelIdRef.current = null;
    setVoiceMembers([]);
    setActiveSpeakerId(null);
    voiceSubscriptionReleaseRef.current?.();
    voiceSubscriptionReleaseRef.current = null;
  }, [activeVoiceChannelId, stopLocalMedia]);

  // ── DM call controls ───────────────────────────────────────────────────────

  const callUser = useCallback(async (targetUserId: number, callerName: string, callerAvatar?: string | null) => {
    setCallState('calling');
    setDmCallUserId(targetUserId);
    sendWS({
      type: 'dm:call-invite',
      recipientId: targetUserId,
      callerName,
      callerAvatar,
    });
  }, []);

  const acceptCall = useCallback(async () => {
    if (!incomingCall) return;
    const callerId = incomingCall.callerId;
    setIncomingCall(null);
    setCallState('connected');
    setDmCallUserId(callerId);
    sendWS({ type: 'dm:call-answer', callerId });
    await startLocalMedia(false);
  }, [incomingCall, startLocalMedia]);

  const rejectCall = useCallback(() => {
    if (!incomingCall) return;
    sendWS({ type: 'dm:call-reject', callerId: incomingCall.callerId });
    setIncomingCall(null);
    setCallState('idle');
  }, [incomingCall]);

  const endCall = useCallback(async () => {
    if (dmCallUserId) {
      sendWS({ type: 'dm:call-end', targetUserId: dmCallUserId });
      closePeerConnection(dmCallUserId);
    }
    stopLocalMedia();
    setCallState('idle');
    setDmCallUserId(null);
    setRemoteStreams(new Map());
  }, [dmCallUserId, stopLocalMedia]);

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
