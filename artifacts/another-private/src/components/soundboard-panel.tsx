import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { csrfFetch } from '@workspace/api-client-react';
import { Music, X, Upload, Loader2, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';

export interface Clip {
  id: number;
  serverId: number;
  name: string;
  durationMs: number;
  sizeBytes: number;
  mimeType: string;
  url: string;
  uploadedBy: number;
  createdAt: string;
}

export interface SoundboardPanelProps {
  isOpen: boolean;
  onClose: () => void;
  serverId?: number | null;
  peerId?: number | null;
  callType: 'voice' | 'dm';
  onTrigger: (clip: Clip) => Promise<void>;
  onClipsLoaded?: (clips: Clip[]) => void;
}

export function SoundboardPanel({
  isOpen,
  onClose,
  serverId,
  peerId,
  callType,
  onTrigger,
  onClipsLoaded,
}: SoundboardPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);

  const { data: sharedServers, isLoading: loadingServers, error: serversError } = useQuery({
    queryKey: ['/api/soundboard/available', peerId],
    queryFn: async () => {
      if (!peerId) return [];
      const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
      const res = await csrfFetch(`${base}/api/soundboard/available?peerId=${peerId}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || err?.message || 'Error al cargar servidores compartidos');
      }
      return res.json() as Promise<Array<{id: number, name: string}>>;
    },
    enabled: isOpen && callType === 'dm' && !!peerId,
  });

  useEffect(() => {
    if (callType === 'dm') {
      if (sharedServers && sharedServers.length > 0) {
        if (!selectedServerId || !sharedServers.some(s => s.id === selectedServerId)) {
          setSelectedServerId(sharedServers[0].id);
        }
      } else {
        setSelectedServerId(null);
      }
    } else if (callType === 'voice') {
      setSelectedServerId(serverId ?? null);
    }
  }, [callType, serverId, sharedServers, selectedServerId]);

  const { data: clips, isLoading: loadingClips, error: clipsError } = useQuery({
    queryKey: ['/api/servers', selectedServerId, 'soundboard'],
    queryFn: async () => {
      if (!selectedServerId) return [];
      const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
      const res = await csrfFetch(`${base}/api/servers/${selectedServerId}/soundboard`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || err?.message || 'Error al cargar sonidos');
      }
      return res.json() as Promise<Clip[]>;
    },
    enabled: isOpen && !!selectedServerId,
    refetchInterval: 20000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (clips && onClipsLoaded) {
      onClipsLoaded(clips);
    }
  }, [clips, onClipsLoaded]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [playingId, setPlayingId] = useState<number | null>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      toast({ title: 'Archivo demasiado grande', description: 'El límite es 256 KiB.', variant: 'destructive' });
      return;
    }
    setUploadFile(file);
    setUploadName(file.name.replace(/\.[^/.]+$/, "").slice(0, 30));
    e.target.value = '';
  };

  const uploadMutation = useMutation({
    mutationFn: async ({ file, name, serverId }: { file: File; name: string; serverId: number }) => {
      if (!serverId || !file || !name.trim()) throw new Error('Faltan datos');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', name.trim());
      const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
      const res = await csrfFetch(`${base}/api/servers/${serverId}/soundboard`, {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        const serverMsg = err?.error || err?.message;
        if (res.status === 403 || res.status === 401) throw new Error(serverMsg || 'No tienes permisos para subir sonidos a este servidor');
        if (res.status === 413) throw new Error(serverMsg || 'El archivo excede el límite de tamaño (256 KiB)');
        if (res.status === 409) throw new Error(serverMsg || 'Conflicto al subir el sonido');
        if (res.status === 400) throw new Error(serverMsg || 'Archivo inválido o límite de sonidos alcanzado (máx 24)');
        throw new Error(serverMsg || 'Error al subir el sonido');
      }
      return res.json() as Promise<Clip>;
    },
    onSuccess: (newClip, { serverId }) => {
      queryClient.setQueryData(['/api/servers', serverId, 'soundboard'], (old: Clip[] | undefined) => {
        if (!old) return [newClip];
        return [...old, newClip];
      });
      queryClient.invalidateQueries({ queryKey: ['/api/servers', serverId, 'soundboard'] });
      setUploadFile(null);
      setUploadName('');
      toast({ title: 'Sonido subido con éxito' });
    },
    onError: (error: any) => {
      toast({ title: 'Error al subir', description: error.message, variant: 'destructive' });
    },
    onSettled: () => {
      setIsUploading(false);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ clipId, serverId }: { clipId: number; serverId: number }) => {
      if (!serverId) throw new Error('No hay servidor seleccionado');
      const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
      const res = await csrfFetch(`${base}/api/servers/${serverId}/soundboard/${clipId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        const serverMsg = err?.error || err?.message;
        if (res.status === 403 || res.status === 401) throw new Error(serverMsg || 'No tienes permisos para borrar este sonido');
        throw new Error(serverMsg || 'Error al borrar el sonido');
      }
    },
    onSuccess: (_, { clipId, serverId }) => {
      queryClient.setQueryData(['/api/servers', serverId, 'soundboard'], (old: Clip[] | undefined) => {
        if (!old) return [];
        return old.filter(c => c.id !== clipId);
      });
      queryClient.invalidateQueries({ queryKey: ['/api/servers', serverId, 'soundboard'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error al borrar', description: error.message, variant: 'destructive' });
    }
  });

  const handlePlay = async (clip: Clip) => {
    if (playingId) return;
    try {
      setPlayingId(clip.id);
      await onTrigger(clip);
    } catch (err: any) {
      toast({ title: 'Error al reproducir', description: err.message || 'No se pudo reproducir el sonido', variant: 'destructive' });
    } finally {
      setPlayingId(null);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          data-testid="soundboard-panel" className="relative w-full max-h-[50dvh] md:absolute md:bottom-[calc(100%+16px)] md:right-4 md:w-96 md:max-h-[500px] bg-card/95 backdrop-blur-xl border border-border shadow-2xl rounded-2xl overflow-hidden flex flex-col z-50"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary/30">
            <h3 className="font-bold text-foreground flex items-center gap-2">
              <Music className="w-4 h-4 text-primary" />
              Soundboard
            </h3>
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-white rounded-lg hover:bg-white/10 transition-colors focus:outline-none focus:ring-2 focus:ring-primary [@media(hover:none)]:flex [@media(hover:none)]:h-11 [@media(hover:none)]:w-11 [@media(hover:none)]:items-center [@media(hover:none)]:justify-center"
              data-testid="button-close-soundboard"
              aria-label="Cerrar Soundboard"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {callType === 'dm' && sharedServers && sharedServers.length > 0 && (
            <div className="px-4 py-2 border-b border-border bg-secondary/20">
              <label className="block text-[10px] font-mono text-muted-foreground uppercase tracking-wider mb-1">
                Servidor de origen
              </label>
              <select
                value={selectedServerId || ''}
                onChange={(e) => setSelectedServerId(Number(e.target.value))}
                className="w-full bg-background border border-border rounded text-sm px-2 py-1.5 focus:outline-none focus:border-primary text-foreground cursor-pointer"
              >
                {sharedServers.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          {callType === 'dm' && serversError && (
            <div className="flex-1 p-6 flex flex-col items-center justify-center text-center gap-3">
              <AlertCircle className="w-8 h-8 text-destructive" />
              <p className="text-sm text-destructive font-medium">{serversError.message}</p>
            </div>
          )}
          
          {callType === 'dm' && !serversError && (!sharedServers || sharedServers.length === 0) && !loadingServers && (
            <div className="flex-1 p-6 flex flex-col items-center justify-center text-center gap-3">
              <AlertCircle className="w-8 h-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No compartes ningún servidor con este usuario. El Soundboard requiere al menos un servidor en común.
              </p>
            </div>
          )}

          {selectedServerId && (
            <>
              <div className="flex-1 overflow-y-auto p-3 min-h-[200px] bg-background/40">
                {loadingClips ? (
                  <div className="h-full flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-primary animate-spin" />
                  </div>
                ) : clipsError ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4">
                    <AlertCircle className="w-6 h-6 text-destructive mb-2" />
                    <p className="text-sm text-destructive font-medium">{clipsError.message}</p>
                  </div>
                ) : clips && clips.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {clips.map(clip => (
                      <div
                        key={clip.id}
                        className="group relative bg-secondary hover:bg-primary/20 border border-border hover:border-primary/40 rounded-xl flex flex-col transition-all aspect-square focus-within:ring-2 focus-within:ring-primary"
                      >
                        <button
                          onClick={() => handlePlay(clip)}
                          disabled={playingId === clip.id}
                          className="flex-1 flex flex-col items-center justify-center gap-2 p-2 w-full h-full text-center disabled:opacity-50 disabled:cursor-not-allowed rounded-xl focus:outline-none"
                          data-testid={`button-play-clip-${clip.id}`}
                          aria-label={`Reproducir ${clip.name}`}
                        >
                          {playingId === clip.id ? (
                            <Loader2 className="w-5 h-5 text-primary animate-spin" />
                          ) : (
                            <Music className="w-5 h-5 text-primary group-hover:scale-110 transition-transform" />
                          )}
                          <span className="text-[10px] text-foreground font-medium truncate w-full leading-tight">
                            {clip.name}
                          </span>
                        </button>
                        <button
                          onClick={() => selectedServerId && deleteMutation.mutate({ clipId: clip.id, serverId: selectedServerId })}
                          className="absolute -top-1.5 -right-1.5 bg-background hover:bg-destructive text-muted-foreground hover:text-destructive-foreground border border-border rounded-full p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 group-focus-within:opacity-100 transition-all z-10 focus:outline-none focus:ring-2 focus:ring-destructive"
                          title="Borrar sonido"
                          aria-label={`Borrar sonido ${clip.name}`}
                          data-testid={`button-delete-clip-${clip.id}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center p-4">
                    <p className="text-sm text-muted-foreground">No hay sonidos en este servidor.</p>
                  </div>
                )}
              </div>

              <div className="p-3 border-t border-border bg-secondary/30">
                {uploadFile ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={uploadName}
                        onChange={e => setUploadName(e.target.value)}
                        placeholder="Nombre del sonido"
                        maxLength={30}
                        className="flex-1 bg-background border border-border rounded-lg px-3 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary"
                        autoFocus
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (!selectedServerId || !uploadFile) return;
                          setIsUploading(true);
                          uploadMutation.mutate({ file: uploadFile, name: uploadName, serverId: selectedServerId });
                        }}
                        disabled={isUploading || !uploadName.trim()}
                        className="flex-1 bg-primary/20 text-primary hover:bg-primary/30 border border-primary/30 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        Guardar
                      </button>
                      <button
                        onClick={() => { setUploadFile(null); setUploadName(''); }}
                        disabled={isUploading}
                        className="px-3 py-1.5 border border-border bg-background rounded-lg text-sm hover:bg-secondary transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[9px] text-muted-foreground font-mono leading-tight">
                      Límite: 100 clips, máx 5s, 256 KiB.<br/>
                      MP3, WAV, OGG, WebM.
                    </div>
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileSelect}
                      accept="audio/mpeg,audio/wav,audio/ogg,audio/webm"
                      className="hidden"
                      aria-label="Seleccionar archivo de sonido"
                    />
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={(clips?.length ?? 0) >= 100}
                      className="bg-secondary hover:bg-muted border border-border rounded-lg px-3 py-1.5 text-xs text-foreground transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Subir clip
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
