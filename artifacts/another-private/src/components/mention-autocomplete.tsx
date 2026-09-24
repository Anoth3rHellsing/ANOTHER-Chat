import { useEffect, useRef, useState } from 'react';
import { sameOriginUploadUrl } from '@/lib/media-url';

interface Member {
  id: number;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}

interface MentionAutocompleteProps {
  value: string;
  cursorPos: number;
  members: Member[];
  onSelect: (newValue: string, newCursor: number) => void;
}

export function useMentionAutocomplete(value: string, cursorPos: number, members: Member[]) {
  const [query, setQuery] = useState<string | null>(null);
  const [startIdx, setStartIdx] = useState<number>(-1);

  useEffect(() => {
    // Find @ before cursor
    const textBefore = value.slice(0, cursorPos);
    const lastAt = textBefore.lastIndexOf('@');
    if (lastAt === -1) { setQuery(null); return; }
    // Make sure there's no space between @ and cursor
    const segment = textBefore.slice(lastAt + 1);
    if (/\s/.test(segment)) { setQuery(null); return; }
    setQuery(segment.toLowerCase());
    setStartIdx(lastAt);
  }, [value, cursorPos]);

  const suggestions = query !== null
    ? members.filter(m =>
        m.username.toLowerCase().startsWith(query) ||
        m.displayName.toLowerCase().startsWith(query)
      ).slice(0, 8)
    : [];

  const insertMention = (member: Member, currentValue: string, currentCursor: number): { newValue: string; newCursor: number } => {
    const before = currentValue.slice(0, startIdx);
    const after = currentValue.slice(currentCursor);
    const mention = `@${member.username} `;
    const newValue = before + mention + after;
    const newCursor = (before + mention).length;
    return { newValue, newCursor };
  };

  return { suggestions, query, insertMention };
}

export function MentionList({
  suggestions,
  onSelect,
  selectedIndex,
}: {
  suggestions: Member[];
  onSelect: (m: Member) => void;
  selectedIndex: number;
}) {
  if (!suggestions.length) return null;
  return (
    <div className="absolute bottom-full left-0 mb-2 w-64 bg-card border border-white/10 rounded-xl shadow-2xl overflow-hidden z-50">
      <div className="px-2 py-1 border-b border-white/5">
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Mencionar usuario</p>
      </div>
      {suggestions.map((m, i) => (
        <button
          key={m.id}
          className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${i === selectedIndex ? 'bg-primary/20 text-foreground' : 'hover:bg-white/5 text-foreground'}`}
          onMouseDown={e => { e.preventDefault(); onSelect(m); }}
        >
          <div className="w-7 h-7 rounded-full bg-secondary overflow-hidden flex-shrink-0">
            {m.avatarUrl && <img src={sameOriginUploadUrl(m.avatarUrl)} className="w-full h-full object-cover" alt="" />}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{m.displayName}</p>
            <p className="text-xs text-muted-foreground font-mono truncate">@{m.username}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
