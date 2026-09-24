import { useState } from 'react';
import { X, Hash, Volume2, Image as ImageIcon, CalendarDays } from 'lucide-react';
import { useCreateChannel } from '@workspace/api-client-react';

interface CreateChannelModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: number;
  onCreated: (channel: any) => void;
}

const CHANNEL_TYPES = [
  {
    type: 'text',
    icon: Hash,
    label: 'Texto',
    description: 'Envía mensajes, imágenes, GIFs y opiniones.',
  },
  {
    type: 'voice',
    icon: Volume2,
    label: 'Voz',
    description: 'Canal para llamadas de voz en tiempo real.',
  },
  {
    type: 'media',
    icon: ImageIcon,
    label: 'Media',
    description: 'Comparte archivos e imágenes con vista previa visual.',
  },
  {
    type: 'calendar',
    icon: CalendarDays,
    label: 'Calendario',
    description: 'Crea eventos, consulta próximos y pasados, y responde si asistirás.',
  },
] as const;

export function CreateChannelModal({ isOpen, onClose, serverId, onCreated }: CreateChannelModalProps) {
  const [channelType, setChannelType] = useState<'text' | 'voice' | 'media' | 'calendar'>('text');
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);

  const createChannel = useCreateChannel();

  if (!isOpen) return null;

  const normalizedName = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!normalizedName.trim()) return;

    createChannel.mutate(
      {
        serverId,
        data: {
          name: normalizedName,
          channelType,
        },
      },
      {
        onSuccess: (channel) => {
          onCreated(channel);
          setName('');
          setChannelType('text');
          setIsPrivate(false);
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
        className="relative w-full max-w-md bg-card border border-white/10 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-xl font-bold text-white">Crear Canal</h2>
              <p className="text-sm text-muted-foreground mt-1">en este servidor</p>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-white transition-colors"
              aria-label="Cerrar creación de canal"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-5">
          {/* Channel type picker */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Tipo de canal
            </label>
            <div className="space-y-2">
              {CHANNEL_TYPES.map(({ type, icon: Icon, label, description }) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setChannelType(type)}
                  aria-pressed={channelType === type}
                  data-testid={`channel-type-${type}`}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all text-left ${
                    channelType === type
                      ? 'border-primary/40 bg-primary/10 text-foreground glow-effect'
                      : 'border-transparent bg-white/5 text-muted-foreground hover:bg-white/20 hover:text-white'
                  }`}
                >
                  <Icon className="w-6 h-6 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      channelType === type ? 'border-primary bg-primary' : 'border-muted-foreground'
                    }`}
                  >
                    {channelType === type && <div className="w-2 h-2 rounded-full bg-primary-foreground" />}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Channel name */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Nombre del canal
            </label>
            <div className="relative flex items-center bg-background border border-white/10 rounded-lg overflow-hidden focus-within:border-primary/50">
              <Hash className="w-4 h-4 text-muted-foreground ml-3 flex-shrink-0" />
              <input
                type="text"
                data-testid="input-channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="nuevo-canal"
                className="flex-1 bg-transparent px-2 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
                autoFocus
                maxLength={100}
              />
            </div>
            {name && normalizedName !== name && (
              <p className="text-xs text-muted-foreground">Se creará como: #{normalizedName}</p>
            )}
          </div>

          {/* Private toggle */}
          <div className="flex items-center justify-between px-4 py-3 bg-white/5 rounded-lg border border-white/5">
            <div>
              <p className="text-sm font-medium text-white">Canal privado</p>
              <p className="text-xs text-muted-foreground mt-0.5">Solo los roles seleccionados podrán ver este canal.</p>
            </div>
            <button
              type="button"
              onClick={() => setIsPrivate(!isPrivate)}
              className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
                isPrivate ? 'bg-primary' : 'bg-white/20'
              }`}
            >
              <div
                className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
                  isPrivate ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 text-sm font-medium text-muted-foreground hover:text-white transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              data-testid="button-create-channel"
              disabled={!normalizedName.trim() || createChannel.isPending}
              className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {createChannel.isPending ? 'Creando...' : 'Crear canal'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
