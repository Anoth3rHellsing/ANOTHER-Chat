import type { MessageReaction } from '@/lib/reactions';

interface ReactionIndicatorsProps {
  reactions?: MessageReaction[];
  currentUserId: number;
  onToggle: (emoji: string) => void;
  getName: (userId: number) => string;
  isPending?: (emoji: string) => boolean;
}

export function ReactionIndicators({ reactions, currentUserId, onToggle, getName, isPending }: ReactionIndicatorsProps) {
  if (!reactions?.length) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1" aria-label="Reacciones">
      {reactions.map(reaction => {
        const mine = reaction.userIds.includes(currentUserId);
        const names = reaction.userIds.map(getName).join(', ');
        const label = `${reaction.emoji}: ${reaction.count} ${reaction.count === 1 ? 'persona' : 'personas'}${names ? ` — ${names}` : ''}. ${mine ? 'Quitar mi reacción' : 'Añadir mi reacción'}`;
        return (
          <button
            key={reaction.emoji}
            type="button"
            onClick={() => onToggle(reaction.emoji)}
            disabled={isPending?.(reaction.emoji)}
            title={names || label}
            aria-label={label}
            aria-pressed={mine}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-all disabled:opacity-50 ${mine
              ? 'bg-primary/20 border-primary/50 text-primary glow-effect'
              : 'bg-secondary border-border text-muted-foreground hover:bg-primary/10 hover:border-primary/30'}`}
          >
            <span aria-hidden="true">{reaction.emoji}</span>
            <span className="font-mono font-medium">{reaction.count}</span>
          </button>
        );
      })}
    </div>
  );
}