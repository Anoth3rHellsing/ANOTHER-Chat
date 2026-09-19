import { useState } from 'react';
import { Flag, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { csrfFetch } from '@workspace/api-client-react';

interface ReportModalProps {
  messageId: number;
  serverId?: number | null;
  authorName: string;
  onClose: () => void;
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';

const REASONS = [
  'Spam o publicidad no solicitada',
  'Contenido inapropiado o explícito',
  'Acoso o comportamiento abusivo',
  'Información falsa o desinformación',
  'Violación de reglas del servidor',
  'Otro',
];

export function ReportModal({ messageId, serverId, authorName, onClose }: ReportModalProps) {
  const { toast } = useToast();
  const [selectedReason, setSelectedReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const reason = selectedReason === 'Otro' ? customReason.trim() : selectedReason;
    if (!reason) return;
    setSubmitting(true);
    try {
      const res = await csrfFetch(`${BASE}/api/messages/${messageId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason, serverId }),
      });
      if (res.ok) {
        toast({ title: 'Reporte enviado. Gracias.' });
        onClose();
      } else {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error ?? 'Error al reportar', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Error de red', variant: 'destructive' });
    }
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-white/10 rounded-2xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-2 text-red-400">
            <Flag className="w-5 h-5" />
            <span className="font-bold font-mono uppercase tracking-wider text-sm">Reportar mensaje</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-muted-foreground hover:text-white rounded-md hover:bg-white/10">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            Estás reportando un mensaje de <span className="text-foreground font-medium">{authorName}</span>. ¿Por qué lo reportas?
          </p>
          <div className="space-y-1.5">
            {REASONS.map(r => (
              <button
                key={r}
                onClick={() => setSelectedReason(r)}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${selectedReason === r ? 'bg-primary/20 text-foreground border border-primary/40' : 'bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground border border-transparent'}`}
              >
                {r}
              </button>
            ))}
          </div>
          {selectedReason === 'Otro' && (
            <textarea
              value={customReason}
              onChange={e => setCustomReason(e.target.value)}
              placeholder="Describe el problema..."
              className="w-full bg-secondary border border-white/10 rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 resize-none h-20"
              autoFocus
            />
          )}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSubmit}
              disabled={!selectedReason || (selectedReason === 'Otro' && !customReason.trim()) || submitting}
              className="flex-1 bg-red-500 hover:bg-red-600 text-white rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-40"
            >
              {submitting ? 'Enviando…' : 'Enviar reporte'}
            </button>
            <button onClick={onClose} className="px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
