import { useGetVoiceMembers } from '@workspace/api-client-react';
import { Users as UsersIcon, Volume2 } from 'lucide-react';
import { sameOriginUploadUrl } from '@/lib/media-url';

interface VoiceChannelRowProps {
  channel: any;
  isActive: boolean;
  isJoined: boolean; // current user is in this channel
  onClick: () => void;
  /** Deja sitio a la derecha para el botón ⋮ de gestión. */
  reserveMenuSpace?: boolean;
}

export function VoiceChannelRow({ channel, isActive, isJoined, onClick, reserveMenuSpace = false }: VoiceChannelRowProps) {
  const { data: voiceMembers } = useGetVoiceMembers(channel.id, {
    query: { refetchInterval: 8000 } as any,
  });

  const vc = channel.visualConfig ?? {};
  const hasVisual = vc.kind && vc.value;
  const memberCount = voiceMembers?.length ?? 0;

  return (
    <div className="mb-0.5">
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors relative overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ${reserveMenuSpace ? 'pr-9' : ''} ${
          isActive || isJoined
            ? 'bg-white/10 text-foreground font-medium'
            : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
        }`}
        style={
          hasVisual && vc.kind === 'gradient'
            ? { background: `linear-gradient(90deg, ${vc.value.split(',')[0]}, ${vc.value.split(',')[1] ?? vc.value.split(',')[0]})`, color: 'white' }
            : hasVisual && vc.kind === 'image'
            ? { backgroundImage: `url(${vc.value})`, backgroundSize: 'cover', backgroundPosition: 'center', color: 'white' }
            : {}
        }
      >
        {hasVisual && <div className="absolute inset-0 bg-black/30 rounded-md" />}
        <Volume2 className={`w-4 h-4 flex-shrink-0 relative z-10 ${isJoined ? 'text-green-400' : 'opacity-60'}`} />
        <span className="truncate relative z-10 flex-1 text-left">{channel.name}</span>
        {channel.restrictedRoles?.length > 0 && (
          <span className="ml-auto text-[10px] text-primary/60 font-mono flex-shrink-0 relative z-10">🔒</span>
        )}
        {memberCount > 0 && (
          <span className={`text-xs font-mono flex-shrink-0 relative z-10 ${isJoined ? 'text-green-400' : 'text-muted-foreground'}`}>
            {memberCount}
          </span>
        )}
      </button>

      {/* Voice members below the channel row */}
      {memberCount > 0 && voiceMembers && (
        <div className="pl-8 pr-2 pb-1 space-y-0.5">
          {voiceMembers.map((member: any) => (
            <div key={member.userId} className="flex items-center gap-1.5 py-0.5">
              <div className="w-5 h-5 rounded-full bg-secondary overflow-hidden flex-shrink-0">
                {member.avatarUrl
                  ? <img src={sameOriginUploadUrl(member.avatarUrl)} className="w-full h-full object-cover" alt="" />
                  : <UsersIcon className="w-3 h-3 m-1 text-muted-foreground" />}
              </div>
              <span className="text-xs text-muted-foreground truncate">{member.displayName}</span>
              {isJoined && member.userId === (member as any).userId && (
                <Volume2 className="w-3 h-3 text-green-400 flex-shrink-0 ml-auto" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
