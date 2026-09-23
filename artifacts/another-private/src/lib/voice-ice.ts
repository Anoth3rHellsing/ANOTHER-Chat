// A JSON array of RTCIceServer objects replaces this list in full when configured.
const PUBLIC_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export function getIceServers(): RTCIceServer[] {
  const raw = import.meta.env.VITE_ICE_SERVERS;
  if (!raw) return PUBLIC_ICE_SERVERS;
  try {
    const servers: unknown = JSON.parse(raw);
    if (!Array.isArray(servers) || !servers.length || !servers.every(
      server => typeof server === 'object' && server !== null &&
        (typeof server.urls === 'string' ||
          (Array.isArray(server.urls) && server.urls.length > 0 &&
            server.urls.every((url: unknown) => typeof url === 'string')))
    )) throw new Error('Se espera un array JSON no vacío de RTCIceServer');
    return servers as RTCIceServer[];
  } catch (error) {
    console.error('[voz] VITE_ICE_SERVERS inválido; se usarán servidores STUN públicos', error);
    return PUBLIC_ICE_SERVERS;
  }
}

// Set VITE_VOICE_DEBUG=true at build time, or localStorage.voiceDebug='true'
// in the browser console. Disable with localStorage.removeItem('voiceDebug').
export function voiceDebug(peerId: number, event: string, details?: object): void {
  if (import.meta.env.VITE_VOICE_DEBUG !== 'true' &&
      localStorage.getItem('voiceDebug') !== 'true') return;
  console.info(`[voz][par ${peerId}] ${event}`, details ?? '');
}

export function candidateType(candidate: string): string {
  return candidate.match(/ typ (host|srflx|prflx|relay)(?:\s|$)/)?.[1] ?? 'desconocido';
}

export async function logSelectedRoute(peerId: number, pc: RTCPeerConnection): Promise<void> {
  if (import.meta.env.VITE_VOICE_DEBUG !== 'true' &&
      localStorage.getItem('voiceDebug') !== 'true') return;
  try {
    const stats = await pc.getStats();
    const pairs = [...stats.values()].filter(
      report => report.type === 'candidate-pair' && (report as RTCStats & { selected?: boolean }).selected
    );
    const transport = [...stats.values()].find(report => report.type === 'transport') as
      (RTCStats & { selectedCandidatePairId?: string }) | undefined;
    const pair = (transport?.selectedCandidatePairId
      ? stats.get(transport.selectedCandidatePairId)
      : pairs[0]) as (RTCStats & { localCandidateId?: string; remoteCandidateId?: string }) | undefined;
    if (!pair) {
      voiceDebug(peerId, 'conectado; ruta ICE aún no disponible');
      return;
    }
    const local = stats.get(pair.localCandidateId ?? '') as
      (RTCStats & { candidateType?: string; protocol?: string }) | undefined;
    const remote = stats.get(pair.remoteCandidateId ?? '') as
      (RTCStats & { candidateType?: string; protocol?: string }) | undefined;
    // Do not log IPs or ports: candidate type and transport suffice.
    voiceDebug(peerId, 'ruta ICE seleccionada', {
      local: local?.candidateType ?? 'desconocido',
      remoto: remote?.candidateType ?? 'desconocido',
      protocolo: local?.protocol ?? remote?.protocol ?? 'desconocido',
    });
  } catch (error) {
    console.warn(`[voz][par ${peerId}] No se pudieron leer estadísticas ICE`, error);
  }
}