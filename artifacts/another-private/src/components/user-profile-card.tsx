import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useGetUserProfile } from '@workspace/api-client-react';
import { X, User as UserIcon, Instagram, Youtube, Twitch, Github, ExternalLink } from 'lucide-react';

interface UserProfileCardProps {
  userId: number;
  currentUserId: number;
  onClose: () => void;
  /** Position hint — card tries to appear near trigger but stays in viewport */
  anchorRect?: DOMRect | null;
}

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-green-500',
  away: 'bg-yellow-500',
  dnd: 'bg-red-500',
  offline: 'bg-gray-500',
};

const STATUS_LABELS: Record<string, string> = {
  online: 'Conectado',
  away: 'Ausente',
  dnd: 'No molestar',
  offline: 'Desconectado',
};

/** Lucide icon or a small SVG for platforms that don't have one */
function SocialIcon({ platform }: { platform: string }) {
  switch (platform) {
    case 'instagram': return <Instagram className="w-4 h-4" />;
    case 'youtube':   return <Youtube className="w-4 h-4" />;
    case 'twitch':    return <Twitch className="w-4 h-4" />;
    case 'github':    return <Github className="w-4 h-4" />;
    case 'twitter':
      // X / Twitter — no Lucide icon, use a simple SVG
      return (
        <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
    default:          return <ExternalLink className="w-4 h-4" />;
  }
}

const PLATFORM_COLORS: Record<string, string> = {
  instagram: 'hover:text-pink-400',
  twitter:   'hover:text-sky-400',
  youtube:   'hover:text-red-500',
  twitch:    'hover:text-purple-400',
  github:    'hover:text-white',
  custom:    'hover:text-primary',
};

export function UserProfileCard({ userId, currentUserId, onClose, anchorRect }: UserProfileCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { data: profile, isLoading } = useGetUserProfile(userId);

  // Close on click-outside and Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const handleClick = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  // Compute position: try to show near anchor, keep in viewport
  const style = (() => {
    if (!anchorRect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    const cardW = 280;
    const cardH = 340;
    const margin = 12;
    let left = anchorRect.right + margin;
    let top = anchorRect.top;
    // Flip left if off-screen right
    if (left + cardW > window.innerWidth - margin) {
      left = anchorRect.left - cardW - margin;
    }
    // Clamp top
    top = Math.max(margin, Math.min(top, window.innerHeight - cardH - margin));
    return { top, left };
  })();

  const gradient = `linear-gradient(135deg, hsl(260,60%,20%) 0%, hsl(220,50%,10%) 100%)`;

  return (
    <AnimatePresence>
      <motion.div
        ref={cardRef}
        key="profile-card"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ type: 'spring', damping: 22, stiffness: 320 }}
        className="fixed z-[100] w-[280px] bg-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        style={style}
      >
        {/* Banner */}
        <div className="h-24 relative flex-shrink-0" style={{ background: gradient }}>
          {profile?.bannerUrl && (
            <img src={profile.bannerUrl} alt="" className="w-full h-full object-cover opacity-70" />
          )}
          <button
            onClick={onClose}
            className="absolute top-2 right-2 w-6 h-6 bg-black/40 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-black/70 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Avatar (overlapping banner) */}
        <div className="px-4 relative" style={{ marginTop: -36 }}>
          <div className="relative inline-block">
            <div className="w-[72px] h-[72px] rounded-full border-4 border-card bg-secondary overflow-hidden">
              {isLoading ? (
                <div className="w-full h-full animate-pulse bg-white/10" />
              ) : profile?.avatarUrl ? (
                <img src={profile.avatarUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <UserIcon className="w-8 h-8 text-muted-foreground" />
                </div>
              )}
            </div>
            {/* Status dot */}
            {profile && (
              <div className={`absolute bottom-1 right-1 w-4 h-4 rounded-full border-[3px] border-card ${STATUS_COLORS[profile.status] ?? 'bg-gray-500'}`} />
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-4 pt-2 pb-4 space-y-3">
          {isLoading ? (
            <div className="space-y-2 pt-1">
              <div className="h-4 bg-white/10 rounded animate-pulse w-3/4" />
              <div className="h-3 bg-white/10 rounded animate-pulse w-1/2" />
            </div>
          ) : profile ? (
            <>
              {/* Name + username */}
              <div>
                <p className="font-bold text-foreground leading-tight">{profile.displayName}</p>
                <p className="text-xs text-muted-foreground font-mono">@{profile.username}</p>
              </div>

              {/* Status badge */}
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[profile.status]}`} />
                <span className="text-xs text-muted-foreground">{STATUS_LABELS[profile.status] ?? profile.status}</span>
              </div>

              {/* Bio */}
              {profile.bio && (
                <p className="text-xs text-foreground/70 leading-relaxed border-t border-white/5 pt-3">{profile.bio}</p>
              )}

              {/* Social links */}
              {profile.socialLinks && profile.socialLinks.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
                  {profile.socialLinks.map((link, i) => (
                    <a
                      key={i}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={link.label || link.platform}
                      className={`p-1.5 rounded-md bg-white/5 text-muted-foreground transition-colors ${PLATFORM_COLORS[link.platform] ?? 'hover:text-primary'}`}
                    >
                      <SocialIcon platform={link.platform} />
                    </a>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground font-mono">Usuario no encontrado</p>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
