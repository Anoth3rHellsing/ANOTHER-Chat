import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { EMOJI_CATALOG, QUICK_EMOJIS } from './emoji-catalog';

export { QUICK_EMOJIS };

export function insertEmojiAtCursor(
  input: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  emoji: string,
  setValue: (value: string) => void
) {
  if (!input) {
    setValue(value + emoji);
    return;
  }
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? value.length;
  const newValue = value.slice(0, start) + emoji + value.slice(end);
  setValue(newValue);
  // Restore cursor position
  setTimeout(() => {
    input.focus();
    input.setSelectionRange(start + emoji.length, start + emoji.length);
  }, 0);
}

export function EmojiPicker({
  onSelect,
  onClose
}: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const filteredEmojis = search
    ? EMOJI_CATALOG.filter(e =>
        e.names.some(name => name.toLowerCase().includes(search.toLowerCase()))
      )
    : EMOJI_CATALOG;

  // Capture previous focus to return focus when closed
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement;
    return () => {
      if (restoreFocusRef.current && previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  // Calculate and update absolute position
  useEffect(() => {
    const updatePosition = () => {
      if (anchorRef.current) {
        const rect = anchorRef.current.getBoundingClientRect();
        const height = Math.min(320, window.innerHeight - 16);
        const width = Math.min(280, window.innerWidth - 16);
        const top = rect.top >= height + 16
          ? rect.top - height - 8
          : Math.min(rect.bottom + 8, window.innerHeight - height - 8);
        const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
        setPosition({ top: Math.max(8, top), left });
      }
    };
    
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        pickerRef.current &&
        !pickerRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        restoreFocusRef.current = true;
        onClose();
      }
    }
    document.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [onClose]);

  // Reset active index on search
  useEffect(() => {
    setActiveIndex(0);
  }, [search]);

  // Scroll active item into view
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (gridRef.current) {
      const activeElement = gridRef.current.children[activeIndex] as HTMLElement;
      if (activeElement) {
        activeElement.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex]);

  const gridColumns = 8;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault(); // Prevent cursor movement in search input
    }
    if (e.key === 'ArrowRight') {
      setActiveIndex(prev => Math.min(prev + 1, filteredEmojis.length - 1));
    } else if (e.key === 'ArrowLeft') {
      setActiveIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'ArrowDown') {
      setActiveIndex(prev => Math.min(prev + gridColumns, filteredEmojis.length - 1));
    } else if (e.key === 'ArrowUp') {
      setActiveIndex(prev => Math.max(prev - gridColumns, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const emoji = filteredEmojis[activeIndex];
      if (emoji) {
        onSelect(emoji.char);
        onClose();
      }
    }
  };

  const pickerContent = (
    <div
      ref={pickerRef}
      className="fixed z-50 flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden w-[280px] max-w-[calc(100vw-1rem)] h-[320px] max-h-[calc(100vh-1rem)] animate-in fade-in zoom-in-95 duration-200"
      style={
        position
          ? {
              top: position.top !== undefined ? `${position.top}px` : undefined,
              left: position.left !== undefined ? `${position.left}px` : undefined,
            }
          : { opacity: 0, pointerEvents: 'none' }
      }
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Selector de emojis"
    >
      <div className="p-3 border-b border-border bg-secondary/50 shrink-0">
        <input
          ref={searchInputRef}
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar emoji..."
          className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
          autoFocus
          aria-label="Buscar emojis por nombre"
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-muted [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
        {filteredEmojis.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm p-4">
            No se encontraron emojis
          </div>
        ) : (
          <div ref={gridRef} className="grid grid-cols-8 gap-1">
            {filteredEmojis.map((emoji, idx) => (
              <button
                key={emoji.char}
                onClick={() => {
                  onSelect(emoji.char);
                  onClose();
                }}
                onMouseEnter={() => setActiveIndex(idx)}
                title={emoji.names[0]}
                aria-label={emoji.names[0]}
                className={`flex items-center justify-center text-xl w-8 h-8 rounded transition-colors ${
                  activeIndex === idx ? 'bg-primary/20 ring-1 ring-primary' : 'hover:bg-muted'
                }`}
                tabIndex={-1}
              >
                {emoji.char}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <div ref={anchorRef} className="absolute inset-0 pointer-events-none" aria-hidden="true" />
      {createPortal(pickerContent, document.body)}
    </>
  );
}