import React, { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  FileText, Download, Trash2, Shield, ShieldAlert,
  AlertTriangle, UploadCloud, X, Check, FileIcon,
  Video, Image as ImageIcon, FileArchive, Search,
  RefreshCw, Clock, AlertCircle
} from 'lucide-react';
import { csrfFetch } from '@workspace/api-client-react';
import { useRealtimeMessages } from '@/providers/realtime-transport';
import { ChunkedUploader } from '@/lib/chunked-upload';
import { useToast } from '@/hooks/use-toast';
import { hasPerm, PERM } from '@/lib/permissions';

interface ChannelFilesPanelProps {
  channelId: number;
  currentUser: { id: number; displayName: string };
  permissions: number;
}

export function ChannelFilesPanel({ channelId, currentUser, permissions }: ChannelFilesPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [uploads, setUploads] = useState<Record<string, { file: File; progress: number; uploader: ChunkedUploader; error?: string }>>({});
  const [verifyTarget, setVerifyTarget] = useState<number | null>(null);
  const [verifyConsent, setVerifyConsent] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const getFilesQueryKey = (cid: number) => ['/api/channels', cid, 'files'];

  const { data, isLoading, isError } = useQuery({
    queryKey: getFilesQueryKey(channelId),
    queryFn: async () => {
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await csrfFetch(`${base}/api/channels/${channelId}/files`);
      if (!res.ok) throw new Error('No se pudieron cargar los archivos');
      return res.json() as Promise<{
        files: any[];
        maxBytes: number;
        scannerAvailable: boolean;
      }>;
    },
    refetchInterval: (query) => {
      const files = (query.state.data as any)?.files ?? [];
      return files.some((f: any) => f.scan?.status === 'queued' || f.scan?.status === 'in_progress') ? 5000 : false;
    }
  });

  useRealtimeMessages(
    ['file:created', 'file:deleted', 'file:scanned'],
    (payload) => {
      if (payload.data?.channelId === channelId) {
        queryClient.invalidateQueries({ queryKey: getFilesQueryKey(channelId) });
      }
    }
  );

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    const files = Array.from(e.target.files);
    e.target.value = '';

    const maxBytes = data?.maxBytes ?? 100 * 1024 * 1024;

    for (const file of files) {
      if (file.size > maxBytes) {
        toast({ title: 'Archivo demasiado grande', description: `${file.name} excede el límite de ${formatBytes(maxBytes)}`, variant: 'destructive' });
        continue;
      }

      const tempId = `temp_${crypto.randomUUID()}_${file.name}`;
      const uploader = new ChunkedUploader(file, channelId);
      
      setUploads(prev => ({
        ...prev,
        [tempId]: { file, progress: 0, uploader }
      }));

      try {
        await uploader.start((p) => {
          setUploads(prev => ({
            ...prev,
            [tempId]: { ...prev[tempId], progress: (p.uploaded / p.total) * 100 }
          }));
        });
        
        setUploads(prev => {
          const next = { ...prev };
          delete next[tempId];
          return next;
        });
        queryClient.invalidateQueries({ queryKey: getFilesQueryKey(channelId) });
      } catch (err: any) {
        setUploads(prev => ({
          ...prev,
          [tempId]: { ...prev[tempId], error: err.message || 'Error de subida' }
        }));
      }
    }
  };

  const handleCancelUpload = (id: string) => {
    const upload = uploads[id];
    if (upload) {
      upload.uploader.abort();
      setUploads(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleRetryUpload = async (id: string) => {
    const upload = uploads[id];
    if (!upload || !upload.file) return;

    setUploads(prev => ({ ...prev, [id]: { ...prev[id], error: undefined, progress: 0 } }));

    try {
      await upload.uploader.start((p) => {
        setUploads(prev => ({
          ...prev,
          [id]: { ...prev[id], progress: (p.uploaded / p.total) * 100 }
        }));
      });

      setUploads(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: getFilesQueryKey(channelId) });
    } catch (err: any) {
      setUploads(prev => ({
        ...prev,
        [id]: { ...prev[id], error: err.message || 'Error de subida' }
      }));
    }
  };

  const handleDelete = async (fileId: number) => {
    if (!confirm('¿Seguro que deseas eliminar este archivo?')) return;
    try {
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await csrfFetch(`${base}/api/channels/${channelId}/files/${fileId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Error al eliminar');
      queryClient.invalidateQueries({ queryKey: getFilesQueryKey(channelId) });
    } catch (err) {
      toast({ title: 'Error', description: 'No se pudo eliminar el archivo', variant: 'destructive' });
    }
  };

  const handleVerify = async () => {
    if (!verifyTarget || !verifyConsent) return;
    setVerifying(true);
    try {
      const base = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await csrfFetch(`${base}/api/channels/${channelId}/files/${verifyTarget}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true })
      });
      if (!res.ok) throw new Error('Error al verificar');
      queryClient.invalidateQueries({ queryKey: getFilesQueryKey(channelId) });
      setVerifyTarget(null);
      toast({ title: 'Escaneo iniciado', description: 'El archivo está siendo analizado.' });
    } catch (err) {
      toast({ title: 'Error', description: 'No se pudo iniciar el escaneo', variant: 'destructive' });
    } finally {
      setVerifying(false);
      setVerifyConsent(false);
    }
  };

  const canManage = hasPerm(permissions, PERM.MANAGE_CHANNELS);
  const files = data?.files ?? [];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background/50 relative overflow-hidden">
      {/* Disclaimer banner */}
      <div className="bg-destructive/10 border-b border-destructive/20 px-4 py-2 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
        <p className="text-xs text-destructive/90 leading-relaxed">
          <strong>Aviso:</strong> Los archivos se almacenan en el disco efímero del servidor y se perderán tras un redespliegue. Este canal es para intercambio rápido de archivos.
        </p>
      </div>
      {data && !data.scannerAvailable && (
        <p className="px-4 py-2 text-xs text-muted-foreground border-b border-border">
          Verificación con VirusTotal no disponible: falta configurar VIRUSTOTAL_API_KEY. Los informes anteriores siguen visibles.
        </p>
      )}

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        {/* Upload area */}
        <div 
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
          role="button"
          tabIndex={0}
          aria-label="Seleccionar archivo para subir"
          className="border-2 border-dashed border-white/10 hover:border-primary/50 bg-secondary/30 rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-colors group"
        >
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-3 group-hover:bg-primary/20 transition-colors">
            <UploadCloud className="w-6 h-6 text-primary" />
          </div>
          <h3 className="font-medium text-foreground mb-1">Subir archivo</h3>
          <p className="text-xs text-muted-foreground max-w-sm">
            Haz clic aquí para seleccionar. {data?.maxBytes ? `Máx ${formatBytes(data.maxBytes)} por archivo.` : ''}
          </p>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileSelect} 
            className="hidden" 
            multiple
          />
        </div>

        {/* Upload progress list */}
        {Object.entries(uploads).map(([id, upload]) => (
          <div key={id} className="bg-secondary/40 border border-white/10 rounded-lg p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-black/20 flex items-center justify-center shrink-0">
              <FileIcon className="w-5 h-5 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-foreground truncate">{upload.file.name}</span>
                <span className="text-xs text-muted-foreground font-mono">{Math.round(upload.progress)}%</span>
              </div>
              <div className="h-1.5 w-full bg-black/40 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-300 ${upload.error ? 'bg-destructive' : 'bg-primary'}`} 
                  style={{ width: `${upload.progress}%` }} 
                />
              </div>
              {upload.error && <p className="text-xs text-destructive mt-1">{upload.error}</p>}
            </div>
            <div className="shrink-0 flex items-center gap-1">
              {upload.error ? (
                <button onClick={() => handleRetryUpload(id)} className="p-1.5 text-muted-foreground hover:text-white" title="Reintentar subida" aria-label="Reintentar subida">
                  <RefreshCw className="w-4 h-4" />
                </button>
              ) : null}
              <button onClick={() => handleCancelUpload(id)} className="p-1.5 text-muted-foreground hover:text-destructive" title="Cancelar" aria-label="Cancelar subida">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {/* Files list */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => <div key={i} className="h-16 bg-white/5 animate-pulse rounded-lg" />)}
          </div>
        ) : isError ? (
          <div className="text-center py-12">
            <AlertCircle className="w-12 h-12 text-destructive/50 mx-auto mb-3" />
            <p className="text-sm text-destructive">Error al cargar los archivos.</p>
          </div>
        ) : files.length === 0 ? (
          <div className="text-center py-12">
            <FileArchive className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Este canal no tiene archivos todavía.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {files.map(file => (
              <FileRow 
                key={file.id} 
                file={file} 
                channelId={channelId} 
                canDelete={canManage || file.uploadedBy === currentUser.id} 
                onDelete={() => handleDelete(file.id)}
                scannerAvailable={data?.scannerAvailable ?? false}
                onVerify={() => setVerifyTarget(file.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Verify Modal */}
      {verifyTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-card border border-white/10 rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <h3 className="font-semibold text-foreground flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                Verificación VirusTotal
              </h3>
              <button onClick={() => { setVerifyTarget(null); setVerifyConsent(false); }} className="text-muted-foreground hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="bg-destructive/10 border border-destructive/20 p-3 rounded-lg flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-destructive shrink-0" />
                <div className="text-sm text-destructive/90 leading-relaxed">
                  <p className="mb-2"><strong>Advertencia de Privacidad</strong></p>
                  <p>
                    Se consultará primero el hash del archivo. <strong>El archivo COMPLETO PUEDE ser enviado</strong> a los servidores de VirusTotal (Google) si no existe un reporte previo. VirusTotal conservará el archivo y puede proporcionarlo a sus clientes de pago.
                  </p>
                </div>
              </div>
              
              <label className="flex items-start gap-3 p-3 bg-white/5 rounded-lg border border-white/10 cursor-pointer hover:bg-white/10 transition-colors">
                <input 
                  type="checkbox" 
                  checked={verifyConsent}
                  onChange={e => setVerifyConsent(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-sm text-foreground">
                  Entiendo que este archivo será compartido con terceros y doy mi consentimiento para enviarlo a VirusTotal.
                </span>
              </label>
            </div>
            <div className="p-4 bg-secondary/50 border-t border-white/10 flex justify-end gap-3">
              <button 
                onClick={() => { setVerifyTarget(null); setVerifyConsent(false); }}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-white"
              >
                Cancelar
              </button>
              <button 
                onClick={handleVerify}
                disabled={!verifyConsent || verifying}
                className="px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
              >
                {verifying ? 'Enviando...' : 'Aceptar y Analizar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileRow({ file, channelId, canDelete, onDelete, scannerAvailable, onVerify }: { file: any, channelId: number, canDelete: boolean, onDelete: () => void, scannerAvailable: boolean, onVerify: () => void }) {
  const getIcon = () => {
    if (file.mimeType.startsWith('image/')) return <ImageIcon className="w-5 h-5 text-primary" />;
    if (file.mimeType.startsWith('video/')) return <Video className="w-5 h-5 text-primary" />;
    if (file.mimeType.includes('zip') || file.mimeType.includes('tar') || file.mimeType.includes('rar')) return <FileArchive className="w-5 h-5 text-destructive" />;
    return <FileText className="w-5 h-5 text-muted-foreground" />;
  };

  const getScanBadge = () => {
    const scanStatus = file.scan?.status;
    if (scanStatus === 'queued') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-primary/10 text-primary border border-primary/20">
          En cola
        </span>
      );
    }
    if (scanStatus === 'in_progress') {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-primary/10 text-primary border border-primary/20">
          <RefreshCw className="w-3 h-3 animate-spin" /> Analizando
        </span>
      );
    }
    if (scanStatus === 'completed') {
      const suspectCount = (file.scan.malicious || 0) + (file.scan.suspicious || 0);
      const harmlessCount = file.scan.harmless || 0;
      const undetectedCount = file.scan.undetected || 0;
      
      const badgeClass = suspectCount > 0 
        ? "bg-destructive/10 text-destructive border-destructive/20" 
        : "bg-primary/10 text-primary border-primary/20";
        
      const Icon = suspectCount > 0 ? ShieldAlert : Check;
      
      const label = suspectCount > 0 
        ? `Peligroso (${suspectCount} detecciones)` 
        : "Sin detecciones";

      return (
        <div className="flex flex-col gap-1 items-start">
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border ${badgeClass}`}>
            <Icon className="w-3 h-3" /> {label}
          </span>
          {(harmlessCount > 0 || undetectedCount > 0 || suspectCount > 0) && (
            <span className="text-[9px] text-muted-foreground font-mono pl-1">
              Motores: {harmlessCount} inofensivo, {undetectedCount} sin detectar, {file.scan.suspicious ?? 0} sospechoso, {file.scan.malicious ?? 0} malicioso
            </span>
          )}
          {file.scan.source && (
            <span className="text-[9px] text-muted-foreground font-mono pl-1">
              {file.scan.source === 'hash' ? 'Informe por huella; no se envió este archivo' :
                file.scan.source === 'local' ? 'Informe reutilizado de otro archivo idéntico' : 'Archivo enviado a VirusTotal'}
              {file.scan.submittedBy ? ` por ${file.scan.submittedBy === file.uploadedBy ? file.uploaderName : `usuario #${file.scan.submittedBy}`}` : ''}
              {file.scan.submittedAt ? ` · ${format(new Date(file.scan.submittedAt), 'dd/MM/yyyy HH:mm')}` : ''}
            </span>
          )}
        </div>
      );
    }
    if (scanStatus === 'error') {
      return (
        <div className="flex flex-col items-start gap-1">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-destructive/10 text-destructive border border-destructive/20">
            <AlertCircle className="w-3 h-3" /> Error de análisis
          </span>
          <span className="text-[10px] text-destructive break-all">{file.scan.error || 'No se pudo completar el análisis'}</span>
          {scannerAvailable && <button onClick={onVerify} className="text-[10px] text-primary hover:underline">Volver a intentar (requiere consentimiento)</button>}
        </div>
      );
    }
    
    // Not scanned yet
    return (
      <button 
        onClick={onVerify}
        disabled={!scannerAvailable}
        title={!scannerAvailable ? 'VirusTotal no está configurado (VIRUSTOTAL_API_KEY)' : 'Analizar con VirusTotal'}
        aria-label="Analizar con VirusTotal"
        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-white transition-colors border border-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Search className="w-3 h-3" />
        {scannerAvailable ? 'Analizar' : 'Escáner no disponible'}
      </button>
    );
  };

  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  const downloadUrl = file.downloadPath ? `${base}${file.downloadPath}` : `${base}/api/channels/${channelId}/files/${file.id}/download`;

  return (
    <div className="bg-secondary/40 border border-white/10 hover:border-white/20 rounded-lg p-3 sm:p-4 flex flex-col sm:flex-row gap-4 items-start sm:items-center transition-colors group">
      <div className="flex-1 min-w-0 flex items-start gap-4 w-full">
        <div className="w-12 h-12 rounded-lg bg-black/20 flex items-center justify-center shrink-0">
          {getIcon()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h4 className="font-medium text-foreground truncate">{file.filename}</h4>
            {getScanBadge()}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono">{formatBytes(file.sizeBytes)}</span>
            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {format(new Date(file.createdAt), 'dd/MM/yyyy HH:mm')}</span>
            <span>Por: <strong className="text-foreground/80 font-normal">{file.uploaderName ?? `Usuario ${file.uploadedBy}`}</strong></span>
            <span className="font-mono text-[10px] text-muted-foreground/50 truncate max-w-[120px]" title={`SHA-256: ${file.sha256}`}>
              {file.sha256 ? `hash:${file.sha256.substring(0,8)}...` : ''}
            </span>
          </div>
        </div>
      </div>
      
      <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-end mt-2 sm:mt-0">
        <a 
          href={downloadUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Descargar ${file.filename}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/20 text-primary hover:bg-primary hover:text-primary-foreground transition-colors text-sm font-medium"
        >
          <Download className="w-4 h-4" />
          Descargar
        </a>
        {canDelete && (
          <button 
            onClick={onDelete}
            aria-label={`Eliminar ${file.filename}`}
            className="p-1.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive rounded-md transition-colors"
            title="Eliminar archivo"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
