import { useState, useRef } from 'react';
import { X, Shield, Upload } from 'lucide-react';
import { useCreateServer } from '@workspace/api-client-react';

interface CreateServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (server: any) => void;
}

export function CreateServerModal({ isOpen, onClose, onCreated }: CreateServerModalProps) {
  const [name, setName] = useState('');
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const createServer = useCreateServer();

  if (!isOpen) return null;

  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIconFile(file);
    const reader = new FileReader();
    reader.onload = () => setIconPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    createServer.mutate(
      { data: { name: name.trim() } },
      {
        onSuccess: async (server) => {
          // If the user picked an icon, upload it now
          if (iconFile) {
            try {
              const form = new FormData();
              form.append('file', iconFile);
              await fetch(`/api/servers/${server.id}/icon`, { method: 'POST', body: form });
            } catch {
              // Non-fatal: server is already created
            }
          }
          onCreated(server);
          setName('');
          setIconPreview(null);
          setIconFile(null);
          onClose();
        },
      }
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md bg-[#1e1f22] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-2">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">Crear un Servidor</h2>
              <p className="text-sm text-[#b5bac1] mt-1 leading-relaxed">
                Tu servidor es donde operas con tu equipo. Crea uno y comienza.
              </p>
            </div>
            <button onClick={onClose} className="p-1 text-[#b5bac1] hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-5">
          {/* Icon upload */}
          <div className="flex flex-col items-center pt-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="relative group w-20 h-20 rounded-full bg-white/10 border-2 border-dashed border-white/20 hover:border-primary/50 overflow-hidden flex items-center justify-center transition-all"
            >
              {iconPreview ? (
                <>
                  <img src={iconPreview} className="w-full h-full object-cover" alt="" />
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity">
                    <Upload className="w-5 h-5 text-white" />
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-1 text-[#87898c] group-hover:text-white transition-colors">
                  <Upload className="w-5 h-5" />
                  <span className="text-[10px] font-mono uppercase tracking-wide">Icono</span>
                </div>
              )}
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleIconChange} />
            <p className="text-xs text-[#87898c] mt-2">Opcional</p>
          </div>

          {/* Server name */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-[#b5bac1]">
              Nombre del servidor
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="El Bunker, Sector 7..."
              className="w-full bg-[#1a1b1e] border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-[#6d6f78] focus:outline-none focus:border-primary/50 transition-colors"
              autoFocus
              maxLength={100}
            />
          </div>

          {/* Disclaimer */}
          <p className="text-xs text-[#87898c] leading-relaxed">
            Al crear un servidor aceptas las normas internas. Actúa con responsabilidad.
          </p>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 text-sm font-medium text-[#b5bac1] hover:text-white transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createServer.isPending}
              className="flex-1 bg-primary hover:bg-primary/90 text-white rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {createServer.isPending ? 'Creando...' : 'Crear servidor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
