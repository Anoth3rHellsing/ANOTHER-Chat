import { useState, useEffect, useRef } from 'react';
import { Play, Heart, MessageSquare, Trash2, X, Upload, Users as UsersIcon } from 'lucide-react';
import { csrfFetch } from '@workspace/api-client-react';
import { AvatarImage } from '@/components/avatar-image';

interface Clip {
  id: number;
  serverId: number;
  userId: number;
  title: string;
  videoUrl: string;
  thumbnailUrl?: string | null;
  createdAt: string;
  author: { username: string; displayName: string; avatarUrl?: string | null };
  likeCount: number;
  liked: boolean;
  commentCount: number;
}

interface Comment {
  id: number;
  content: string;
  createdAt: string;
  userId: number;
  author: { username: string; displayName: string; avatarUrl?: string | null };
}

interface ClipsViewProps {
  serverId: number;
  currentUserId: number;
}

function getSameOriginClipMediaUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    // Legacy rows stored absolute development URLs. Extract only a strictly
    // validated app upload path, then force it onto this app's own origin.
    const parsed = new URL(value, window.location.origin);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^\/api\/uploads\/clip-[0-9]+-[a-z0-9]+\.[a-z0-9]{1,12}$/i.test(parsed.pathname)
    ) {
      return null;
    }
    return `${baseUrl}${parsed.pathname}`;
  } catch {
    return null;
  }
}

export function ClipsView({ serverId, currentUserId }: ClipsViewProps) {
  const [clips, setClips] = useState<Clip[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentInput, setCommentInput] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
  const selectedVideoUrl = selectedClip
    ? getSameOriginClipMediaUrl(selectedClip.videoUrl, baseUrl)
    : null;

  const fetchClips = async () => {
    try {
      setLoading(true);
      const res = await csrfFetch(`${baseUrl}/api/servers/${serverId}/clips`, { credentials: 'include' });
      if (res.ok) setClips(await res.json());
    } catch {}
    setLoading(false);
  };

  const fetchComments = async (clipId: number) => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/clips/${clipId}/comments`, { credentials: 'include' });
      if (res.ok) setComments(await res.json());
    } catch {}
  };

  useEffect(() => { fetchClips(); }, [serverId]);

  const handleLike = async (clip: Clip) => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/clips/${clip.id}/like`, { method: 'POST', credentials: 'include' });
      if (res.ok) {
        const { liked } = await res.json();
        setClips(prev => prev.map(c => c.id === clip.id
          ? { ...c, liked, likeCount: liked ? c.likeCount + 1 : c.likeCount - 1 }
          : c
        ));
        if (selectedClip?.id === clip.id) {
          setSelectedClip(prev => prev ? { ...prev, liked, likeCount: liked ? prev.likeCount + 1 : prev.likeCount - 1 } : null);
        }
      }
    } catch {}
  };

  const handleOpenClip = async (clip: Clip) => {
    setSelectedClip(clip);
    await fetchComments(clip.id);
  };

  const handleComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentInput.trim() || !selectedClip) return;
    try {
      const res = await csrfFetch(`${baseUrl}/api/clips/${selectedClip.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content: commentInput.trim() }),
      });
      if (res.ok) {
        const comment = await res.json();
        setComments(prev => [...prev, comment]);
        setCommentInput('');
        setSelectedClip(prev => prev ? { ...prev, commentCount: prev.commentCount + 1 } : null);
        setClips(prev => prev.map(c => c.id === selectedClip.id ? { ...c, commentCount: c.commentCount + 1 } : c));
      }
    } catch {}
  };

  const handleDelete = async (clipId: number) => {
    try {
      await csrfFetch(`${baseUrl}/api/clips/${clipId}`, { method: 'DELETE', credentials: 'include' });
      setClips(prev => prev.filter(c => c.id !== clipId));
      if (selectedClip?.id === clipId) setSelectedClip(null);
    } catch {}
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile || !uploadTitle.trim()) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', uploadFile);
      form.append('title', uploadTitle.trim());
      const res = await csrfFetch(`${baseUrl}/api/servers/${serverId}/clips`, {
        method: 'POST',
        body: form,
        credentials: 'include',
      });
      if (res.ok) {
        setUploadOpen(false);
        setUploadTitle('');
        setUploadFile(null);
        await fetchClips();
      }
    } catch {}
    setUploading(false);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="h-12 border-b border-white/5 flex items-center px-4 justify-between bg-card/30 backdrop-blur-sm z-10 flex-shrink-0">
        <div className="flex items-center gap-2 text-foreground font-medium">
          <Play className="w-4 h-4 text-primary" />
          <span>Clips</span>
        </div>
        <button
          onClick={() => setUploadOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg text-xs font-mono transition-colors"
        >
          <Upload className="w-3.5 h-3.5" />
          Subir clip
        </button>
      </div>

      {/* Upload modal */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center" onClick={() => setUploadOpen(false)}>
          <div className="bg-card border border-white/10 rounded-xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="font-bold text-foreground mb-4 font-mono uppercase tracking-wider text-sm">Subir clip</h3>
            <form onSubmit={handleUpload} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Título</label>
                <input
                  type="text"
                  value={uploadTitle}
                  onChange={e => setUploadTitle(e.target.value)}
                  className="w-full mt-1 bg-secondary border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-primary/50"
                  placeholder="Nombre del clip..."
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground font-mono uppercase tracking-wider">Video</label>
                <div
                  className="mt-1 border-2 border-dashed border-white/20 rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploadFile
                    ? <p className="text-sm text-foreground">{uploadFile.name}</p>
                    : <><Upload className="w-6 h-6 mx-auto mb-1 text-muted-foreground" /><p className="text-xs text-muted-foreground">MP4, MOV, WebM (máx. 100 MB)</p></>
                  }
                </div>
                <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={e => setUploadFile(e.target.files?.[0] ?? null)} />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={!uploadFile || !uploadTitle.trim() || uploading}
                  className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg py-2 text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {uploading ? 'Subiendo...' : 'Subir'}
                </button>
                <button type="button" onClick={() => setUploadOpen(false)} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Grid / viewer */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm font-mono">Cargando...</div>
        ) : clips.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground gap-3">
            <Play className="w-12 h-12 opacity-20" />
            <p className="text-sm font-mono">Sin clips todavía.</p>
          </div>
        ) : selectedClip ? (
          /* Detail view */
          <div className="flex flex-col h-full">
            <div className="p-3 border-b border-white/5 flex items-center gap-2">
              <button onClick={() => setSelectedClip(null)} className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10">
                <X className="w-4 h-4" />
              </button>
              <span className="text-sm font-medium text-foreground truncate flex-1">{selectedClip.title}</span>
            </div>
            <div className="p-4 space-y-3">
              {selectedVideoUrl ? (
                <video src={selectedVideoUrl} controls className="w-full rounded-xl border border-white/10 max-h-72 bg-black" />
              ) : (
                <p role="alert" className="text-sm text-muted-foreground">El vídeo del clip no está disponible.</p>
              )}
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                  {selectedClip.author.avatarUrl ? <AvatarImage url={selectedClip.author.avatarUrl} /> : <UsersIcon className="w-4 h-4 m-2 text-muted-foreground" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">{selectedClip.author.displayName}</p>
                  <p className="text-xs text-muted-foreground font-mono">{new Date(selectedClip.createdAt).toLocaleDateString('es')}</p>
                </div>
                <button
                  onClick={() => handleLike(selectedClip)}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm transition-colors ${selectedClip.liked ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-muted-foreground hover:text-red-400'}`}
                >
                  <Heart className={`w-4 h-4 ${selectedClip.liked ? 'fill-current' : ''}`} />
                  {selectedClip.likeCount}
                </button>
                {selectedClip.userId === currentUserId && (
                  <button onClick={() => handleDelete(selectedClip.id)} className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Comments */}
              <div className="border-t border-white/5 pt-3 space-y-2">
                <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  {comments.length} comentarios
                </p>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {comments.map(c => (
                    <div key={c.id} className="flex gap-2 text-sm">
                      <div className="w-6 h-6 rounded-full bg-secondary overflow-hidden flex-shrink-0 mt-0.5">
                        {c.author.avatarUrl && <AvatarImage url={c.author.avatarUrl} />}
                      </div>
                      <div>
                        <span className="font-medium text-foreground text-xs">{c.author.displayName} </span>
                        <span className="text-foreground/80">{c.content}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <form onSubmit={handleComment} className="flex gap-2 mt-2">
                  <input
                    type="text"
                    value={commentInput}
                    onChange={e => setCommentInput(e.target.value)}
                    placeholder="Añade un comentario..."
                    className="flex-1 bg-secondary border border-white/10 rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                  />
                  <button type="submit" disabled={!commentInput.trim()} className="px-3 py-1.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm disabled:opacity-50">
                    OK
                  </button>
                </form>
              </div>
            </div>
          </div>
        ) : (
          /* Grid */
          <div className="grid grid-cols-2 gap-2 p-4">
            {clips.map(clip => {
              const thumbnailUrl = getSameOriginClipMediaUrl(clip.thumbnailUrl, baseUrl);
              return (
              <button
                key={clip.id}
                onClick={() => handleOpenClip(clip)}
                className="group relative rounded-xl overflow-hidden bg-secondary border border-white/10 aspect-video hover:border-white/30 transition-all"
              >
                {thumbnailUrl
                  ? <img src={thumbnailUrl} className="w-full h-full object-cover" alt={clip.title} />
                  : <div className="w-full h-full flex items-center justify-center bg-black/50">
                      <Play className="w-8 h-8 text-white/40" />
                    </div>
                }
                <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <Play className="w-10 h-10 text-white" />
                </div>
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 p-2">
                  <p className="text-white text-xs font-medium truncate">{clip.title}</p>
                  <div className="flex items-center gap-2 text-white/60 text-[10px] mt-0.5">
                    <span className="flex items-center gap-0.5"><Heart className="w-2.5 h-2.5" />{clip.likeCount}</span>
                    <span className="flex items-center gap-0.5"><MessageSquare className="w-2.5 h-2.5" />{clip.commentCount}</span>
                  </div>
                </div>
              </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
