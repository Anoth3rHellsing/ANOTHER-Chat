import { format } from 'date-fns';
import { AlertCircle, Check, ExternalLink, RefreshCw, ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

export type FileScan = {
  status: 'unavailable' | 'not_started' | 'queued' | 'in_progress' | 'completed' | 'error';
  sha256: string;
  harmless: number | null;
  undetected: number | null;
  suspicious: number | null;
  malicious: number | null;
  source: 'local' | 'hash' | 'upload' | null;
  submittedBy: number | null;
  submittedByName?: string | null;
  submittedAt: string | null;
  completedAt?: string | null;
  error?: string | null;
};

export type ScanPresentation = 'none' | 'pending' | 'clear' | 'detected' | 'inconclusive';

export function scanPresentation(scan: FileScan): ScanPresentation {
  if (scan.status === 'not_started' || scan.status === 'unavailable') return 'none';
  if (scan.status === 'queued' || scan.status === 'in_progress') return 'pending';
  if (scan.status !== 'completed') return 'inconclusive';
  const counts = [scan.harmless, scan.undetected, scan.suspicious, scan.malicious];
  if (counts.some(count => !Number.isSafeInteger(count) || (count ?? -1) < 0) ||
      counts.every(count => count === 0)) return 'inconclusive';
  return (scan.suspicious ?? 0) + (scan.malicious ?? 0) > 0 ? 'detected' : 'clear';
}

function displayDate(value?: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'No consta';
  return format(new Date(value), 'dd/MM/yyyy HH:mm');
}

export function FileScanResult({ fileId, filename, scan, onRetry }: {
  fileId: number;
  filename: string;
  scan: FileScan;
  onRetry?: () => void;
}) {
  const presentation = scanPresentation(scan);
  if (presentation === 'none') return null;

  const detections = (scan.suspicious ?? 0) + (scan.malicious ?? 0);
  const pending = presentation === 'pending';
  const title = presentation === 'detected' ? `Con detecciones · ${detections} ${detections === 1 ? 'motor' : 'motores'}`
    : presentation === 'clear' ? 'Sin detecciones'
    : pending ? scan.status === 'queued' ? 'En cola' : 'Analizando…'
    : 'No concluyente';
  const Icon = presentation === 'detected' ? ShieldAlert
    : presentation === 'clear' ? Check : pending ? RefreshCw : AlertCircle;
  const badgeClass = presentation === 'detected'
    ? 'bg-destructive text-destructive-foreground border-destructive font-bold'
    : presentation === 'clear'
    ? 'bg-secondary text-muted-foreground border-border'
    : 'bg-secondary/60 text-muted-foreground border-border';
  const reportUrl = presentation !== 'pending' && /^[a-f0-9]{64}$/i.test(scan.sha256)
    && scan.status === 'completed'
    ? `https://www.virustotal.com/gui/file/${scan.sha256.toLowerCase()}/detection`
    : null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            data-testid={`button-file-scan-${fileId}`}
            aria-label={`Ver resultado de VirusTotal de ${filename}: ${title}`}
            className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${badgeClass}`}
          >
            <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} />
            <span data-testid={`status-file-scan-${fileId}`}>{title}</span>
            <span className="font-normal opacity-80">· VirusTotal</span>
          </button>
        </DialogTrigger>
        <DialogContent data-testid={`dialog-file-scan-${fileId}`}>
          <DialogHeader>
            <DialogTitle>Resultado del análisis</DialogTitle>
            <DialogDescription className="break-words">{filename} · VirusTotal</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm text-foreground">
            <p className={`flex items-center gap-2 font-medium ${presentation === 'detected' ? 'text-destructive' : 'text-muted-foreground'}`}
              data-testid={`text-file-scan-summary-${fileId}`}>
              <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${pending ? 'animate-spin' : ''}`} />
              {title}
            </p>
            <p className="text-muted-foreground">
              {presentation === 'detected' ? 'Uno o más motores señalaron este archivo. Ten precaución antes de abrirlo.'
                : presentation === 'clear' ? 'Los motores que respondieron no señalaron este archivo.'
                : pending ? 'El análisis sigue en curso. Este resultado se actualizará al terminar.'
                : 'No se obtuvo un resultado suficiente para evaluar este archivo.'}
            </p>
            {presentation === 'inconclusive' && scan.error && (
              <p className="text-xs text-muted-foreground break-words">Motivo: {scan.error}</p>
            )}
            <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-secondary/40 p-3">
              {([
                ['Malicioso', scan.malicious],
                ['Sospechoso', scan.suspicious],
                ['Sin detectar', scan.undetected],
                ['Inofensivo', scan.harmless],
              ] as const).map(([label, count]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="font-medium">{scan.status === 'completed' && count !== null ? count : 'Sin datos'}</dd>
                </div>
              ))}
            </dl>
            <dl className="space-y-1 text-xs text-muted-foreground">
              <div><dt className="inline">Solicitado por: </dt><dd className="inline text-foreground">{scan.submittedByName ?? (scan.submittedBy ? `Usuario #${scan.submittedBy}` : 'No consta')}</dd></div>
              <div><dt className="inline">Solicitado: </dt><dd className="inline text-foreground">{displayDate(scan.submittedAt)}</dd></div>
              <div><dt className="inline">{scan.source === 'local' ? 'Informe original: ' : 'Resultado: '}</dt><dd className="inline text-foreground">{displayDate(scan.completedAt)}</dd></div>
              {scan.source === 'local' && <div>Informe reutilizado de un archivo idéntico.</div>}
              {scan.source === 'hash' && <div>Informe encontrado por huella; este archivo no se volvió a enviar.</div>}
            </dl>
            {reportUrl && (
              <a data-testid={`link-file-scan-report-${fileId}`} href={reportUrl} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-primary underline underline-offset-2">
                Ver informe completo en VirusTotal <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
            )}
            <p data-testid={`text-file-scan-warning-${fileId}`} className="border-t border-border pt-3 text-xs text-muted-foreground">
              Que ningún motor lo detecte no garantiza que el archivo sea seguro: el software malicioso reciente puede pasar desapercibido.
            </p>
          </div>
        </DialogContent>
      </Dialog>
      {presentation === 'inconclusive' && onRetry && (
        <button type="button" data-testid={`button-retry-file-scan-${fileId}`}
          onClick={onRetry} className="text-xs text-primary hover:underline">
          Reintentar (requiere consentimiento)
        </button>
      )}
    </div>
  );
}