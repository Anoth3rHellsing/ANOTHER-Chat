import { useState, useEffect, useRef } from 'react';
import { Plus, X, Users as UsersIcon } from 'lucide-react';
import { StoryViewer } from './story-viewer';
import { csrfFetch } from '@workspace/api-client-react';

interface StoryGroup {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  stories: Array<{
    id: number;
    mediaUrl: string;
    mediaType: string;
    expiresAt: string;
    createdAt: string;
    viewed: boolean;
  }>;
  hasUnviewed: boolean;
}

interface StoryBarProps {
  currentUserId: number;
  currentUser: any;
}

export function StoryBar({ currentUserId, currentUser }: StoryBarProps) {
  const [groups, setGroups] = useState<StoryGroup[]>([]);
  const [viewingGroup, setViewingGroup] = useState<StoryGroup | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');

  const fetchStories = async () => {
    try {
      const res = await csrfFetch(`${baseUrl}/api/stories`, { credentials: 'include' });
      if (res.ok) setGroups(await res.json());
    } catch {}
  };

  useEffect(() => {
    fetchStories();
    const interval = setInterval(fetchStories, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await csrfFetch(`${baseUrl}/api/stories`, { method: 'POST', body: form, credentials: 'include' });
      await fetchStories();
    } catch {}
    setUploading(false);
  };

  const handleView = (group: StoryGroup) => {
    setViewingGroup(group);
    // Mark all stories in this group as viewed
    group.stories.forEach(s => {
      if (!s.viewed) {
        csrfFetch(`${baseUrl}/api/stories/${s.id}/view`, { method: 'POST', credentials: 'include' }).catch(() => {});
      }
    });
  };

  const onViewerClose = () => {
    setViewingGroup(null);
    fetchStories(); // refresh viewed state
  };

  const myGroup = groups.find(g => g.userId === currentUserId);
  const othersGroups = groups.filter(g => g.userId !== currentUserId);

  return (
    <>
      <div className="px-2 py-2 border-b border-white/5">
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
          {/* My story / Add story */}
          <button
            onClick={() => myGroup ? handleView(myGroup) : fileInputRef.current?.click()}
            className="flex flex-col items-center gap-1 flex-shrink-0 group"
            title={myGroup ? 'Ver mi historia' : 'Añadir historia'}
          >
            <div className={`w-10 h-10 rounded-full relative ${myGroup ? 'p-[2px] bg-gradient-to-tr from-purple-500 via-pink-500 to-yellow-400' : 'border-2 border-dashed border-white/30 hover:border-primary/60'}`}>
              <div className="w-full h-full rounded-full bg-card overflow-hidden flex items-center justify-center">
                {currentUser?.avatarUrl
                  ? <img src={currentUser.avatarUrl} className="w-full h-full object-cover" alt="" />
                  : <UsersIcon className="w-4 h-4 text-muted-foreground" />}
              </div>
              {!myGroup && (
                <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-primary rounded-full flex items-center justify-center border-2 border-card">
                  <Plus className="w-2.5 h-2.5 text-white" />
                </div>
              )}
            </div>
            <span className="text-[9px] text-muted-foreground font-mono truncate w-10 text-center">
              {uploading ? '...' : 'Tú'}
            </span>
          </button>

          {/* Other users' stories */}
          {othersGroups.map(group => (
            <button
              key={group.userId}
              onClick={() => handleView(group)}
              className="flex flex-col items-center gap-1 flex-shrink-0"
              title={group.displayName}
            >
              <div className={`w-10 h-10 rounded-full p-[2px] ${group.hasUnviewed ? 'bg-gradient-to-tr from-purple-500 via-pink-500 to-yellow-400' : 'bg-white/20'}`}>
                <div className="w-full h-full rounded-full bg-card overflow-hidden">
                  {group.avatarUrl
                    ? <img src={group.avatarUrl} className="w-full h-full object-cover" alt="" />
                    : <UsersIcon className="w-4 h-4 m-3 text-muted-foreground" />}
                </div>
              </div>
              <span className="text-[9px] text-muted-foreground font-mono truncate w-10 text-center">{group.displayName.split(' ')[0]}</span>
            </button>
          ))}
        </div>
        <input ref={fileInputRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleUpload} />
      </div>

      {viewingGroup && (
        <StoryViewer
          group={viewingGroup}
          currentUserId={currentUserId}
          onClose={onViewerClose}
        />
      )}
    </>
  );
}
