import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Eye, Trash2 } from 'lucide-react';
import { csrfFetch } from '@workspace/api-client-react';

interface Story {
  id: number;
  mediaUrl: string;
  mediaType: string;
  expiresAt: string;
  createdAt: string;
  viewed: boolean;
}

interface StoryGroup {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  stories: Story[];
  hasUnviewed: boolean;
}

interface StoryViewerProps {
  group: StoryGroup;
  currentUserId: number;
  onClose: () => void;
}

const STORY_DURATION = 5000; // 5s per story

export function StoryViewer({ group, currentUserId, onClose }: StoryViewerProps) {
  const [storyIndex, setStoryIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewers, setViewers] = useState<any[]>([]);
  const [showViewers, setShowViewers] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const markedStoryRef = useRef<number | null>(null);
  const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
  const isOwn = group.userId === currentUserId;

  const current = group.stories[storyIndex];

  useEffect(() => {
    if (!current || current.viewed || markedStoryRef.current === current.id) return;
    markedStoryRef.current = current.id;
    csrfFetch(`${baseUrl}/api/stories/${current.id}/view`, { method: 'POST', credentials: 'include' })
      .catch(() => {
        if (markedStoryRef.current === current.id) markedStoryRef.current = null;
      });
  }, [current?.id, current?.viewed, baseUrl]);

  const goNext = useCallback(() => {
    if (storyIndex < group.stories.length - 1) {
      setStoryIndex(i => i + 1);
      setProgress(0);
    } else {
      onClose();
    }
  }, [storyIndex, group.stories.length, onClose]);

  const goPrev = () => {
    if (storyIndex > 0) {
      setStoryIndex(i => i - 1);
      setProgress(0);
    }
  };

  // Auto-progress
  useEffect(() => {
    if (paused || current?.mediaType === 'video') return;
    setProgress(0);
    const step = 100 / (STORY_DURATION / 50);
    intervalRef.current = setInterval(() => {
      setProgress(p => {
        if (p >= 100) {
          clearInterval(intervalRef.current!);
          goNext();
          return 100;
        }
        return p + step;
      });
    }, 50);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [storyIndex, paused, current?.mediaType]);

  // Fetch viewers if own story
  useEffect(() => {
    if (isOwn && current) {
      csrfFetch(`${baseUrl}/api/stories/${current.id}/viewers`, { credentials: 'include' })
        .then(r => r.json()).then(setViewers).catch(() => {});
    }
  }, [storyIndex, isOwn]);

  const handleDelete = async () => {
    await csrfFetch(`${baseUrl}/api/stories/${current.id}`, { method: 'DELETE', credentials: 'include' });
    onClose();
  };

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center" onClick={onClose}>
      <div
        className="relative w-full max-w-sm h-full max-h-[90vh] bg-black rounded-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
        onMouseDown={() => setPaused(true)}
        onMouseUp={() => setPaused(false)}
        onTouchStart={() => setPaused(true)}
        onTouchEnd={() => setPaused(false)}
      >
        {/* Progress bars */}
        <div className="absolute top-0 left-0 right-0 z-10 flex gap-1 p-2">
          {group.stories.map((_, i) => (
            <div key={i} className="flex-1 h-0.5 bg-white/30 rounded-full overflow-hidden">
              <div
                className="h-full bg-white rounded-full transition-none"
                style={{ width: i < storyIndex ? '100%' : i === storyIndex ? `${progress}%` : '0%' }}
              />
            </div>
          ))}
        </div>

        {/* Header */}
        <div className="absolute top-4 left-0 right-0 z-10 flex items-center gap-2 px-4 pt-1">
          <div className="w-8 h-8 rounded-full overflow-hidden border border-white/20 flex-shrink-0">
            {group.avatarUrl
              ? <img src={group.avatarUrl} className="w-full h-full object-cover" alt="" />
              : <div className="w-full h-full bg-secondary" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-xs font-semibold truncate">{group.displayName}</p>
            <p className="text-white/60 text-[10px] font-mono">
              {new Date(current.createdAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
          <div className="flex gap-1">
            {isOwn && (
              <>
                <button
                  onClick={() => setShowViewers(v => !v)}
                  className="p-1.5 text-white/70 hover:text-white rounded-full hover:bg-white/10"
                >
                  <Eye className="w-4 h-4" />
                </button>
                <button
                  onClick={handleDelete}
                  className="p-1.5 text-white/70 hover:text-red-400 rounded-full hover:bg-white/10"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
            <button onClick={onClose} className="p-1.5 text-white/70 hover:text-white rounded-full hover:bg-white/10">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Media */}
        <div className="w-full h-full flex items-center justify-center bg-black">
          {current.mediaType === 'video' ? (
            <video
              key={current.id}
              src={current.mediaUrl}
              className="w-full h-full object-contain"
              autoPlay
              playsInline
              onEnded={goNext}
            />
          ) : (
            <img
              key={current.id}
              src={current.mediaUrl}
              className="w-full h-full object-contain"
              alt=""
            />
          )}
        </div>

        {/* Navigation click zones */}
        <button
          className="absolute left-0 top-0 bottom-0 w-1/3 z-10"
          onClick={goPrev}
          aria-label="Anterior"
        />
        <button
          className="absolute right-0 top-0 bottom-0 w-1/3 z-10"
          onClick={goNext}
          aria-label="Siguiente"
        />

        {/* Viewer list overlay */}
        {showViewers && isOwn && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/90 rounded-t-2xl p-4 z-20 max-h-48 overflow-y-auto">
            <p className="text-white/60 text-xs font-mono uppercase tracking-wider mb-2 flex items-center gap-1">
              <Eye className="w-3 h-3" />
              {viewers.length} vistas
            </p>
            {viewers.map(v => (
              <div key={v.userId} className="flex items-center gap-2 py-1.5">
                <div className="w-6 h-6 rounded-full overflow-hidden bg-secondary flex-shrink-0">
                  {v.avatarUrl && <img src={v.avatarUrl} className="w-full h-full object-cover" alt="" />}
                </div>
                <span className="text-white text-xs">{v.displayName}</span>
                <span className="text-white/70 text-[10px] ml-auto font-mono">
                  {new Date(v.viewedAt).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            {viewers.length === 0 && (
              <p className="text-white/70 text-xs font-mono">Nadie la ha visto todavía.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
