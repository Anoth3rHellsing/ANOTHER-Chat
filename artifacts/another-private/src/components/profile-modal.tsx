import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useUpdateMyProfile, getGetCurrentUserQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Upload, CheckCircle2, Circle, Loader2, User as UserIcon } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { User } from '@workspace/api-client-react';

interface ProfileModalProps {
  user: User;
  isOpen: boolean;
  onClose: () => void;
}

const statusOptions = [
  { value: 'online', label: 'Conectado', color: 'bg-green-500' },
  { value: 'away', label: 'Ausente', color: 'bg-yellow-500' },
  { value: 'dnd', label: 'No molestar', color: 'bg-red-500' },
  { value: 'offline', label: 'Desconectado', color: 'bg-gray-500' }
] as const;

export function ProfileModal({ user, isOpen, onClose }: ProfileModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateProfile = useUpdateMyProfile();
  
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio || '');
  const [status, setStatus] = useState<any>(user.status);
  
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl);
  const [bannerUrl, setBannerUrl] = useState(user.bannerUrl);
  
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isUploadingBanner, setIsUploadingBanner] = useState(false);

  const fileInputAvatar = useRef<HTMLInputElement>(null);
  const fileInputBanner = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setDisplayName(user.displayName);
      setBio(user.bio || '');
      setStatus(user.status);
      setAvatarUrl(user.avatarUrl);
      setBannerUrl(user.bannerUrl);
    }
  }, [isOpen, user]);

  const handleSave = () => {
    updateProfile.mutate({ data: { displayName, bio, status } }, {
      onSuccess: (updatedUser) => {
        queryClient.setQueryData(getGetCurrentUserQueryKey(), updatedUser);
        toast({ title: "Perfil actualizado" });
        onClose();
      }
    });
  };

  const uploadFile = async (file: File, type: 'avatar' | 'banner') => {
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      if (type === 'avatar') setIsUploadingAvatar(true);
      else setIsUploadingBanner(true);
      
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, '');
      const res = await fetch(`${baseUrl}/api/users/me/${type}`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      
      if (!res.ok) throw new Error("Error en la subida");
      
      const data = await res.json();
      
      if (type === 'avatar') setAvatarUrl(data.url);
      else setBannerUrl(data.url);
      
      // Update local cache manually for instant feedback
      queryClient.setQueryData(getGetCurrentUserQueryKey(), (old: any) => {
        if (!old) return old;
        return { ...old, [type === 'avatar' ? 'avatarUrl' : 'bannerUrl']: data.url };
      });
      
      toast({ title: "Imagen actualizada" });
    } catch (err) {
      toast({ title: "Error al subir la imagen", variant: "destructive" });
    } finally {
      if (type === 'avatar') setIsUploadingAvatar(false);
      else setIsUploadingBanner(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div 
            initial={{ opacity: 0, y: 100, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 100, scale: 0.95 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed inset-0 m-auto z-50 w-full max-w-lg h-fit bg-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header / Banner Area */}
            <div className="relative h-32 bg-secondary flex items-center justify-center overflow-hidden group">
              {bannerUrl ? (
                <img src={bannerUrl} alt="Banner" className="w-full h-full object-cover opacity-60" />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-tr from-primary/20 to-transparent" />
              )}
              
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <button 
                  onClick={() => fileInputBanner.current?.click()}
                  className="bg-black/50 text-white p-2 rounded-full hover:bg-black/80 transition-colors"
                >
                  {isUploadingBanner ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                </button>
              </div>
              <input type="file" ref={fileInputBanner} accept="image/*" className="hidden" onChange={e => e.target.files?.[0] && uploadFile(e.target.files[0], 'banner')} />
              
              <button onClick={onClose} className="absolute top-4 right-4 bg-black/50 text-white/70 hover:text-white p-1 rounded-full backdrop-blur-md">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Avatar — sits OUTSIDE the overflow-y-auto so it can visually overlap the banner */}
            <div className="px-6 pt-0 relative z-10">
              <div className="relative -mt-10 mb-4 inline-block group">
                <div className="w-20 h-20 rounded-full border-4 border-card bg-secondary flex items-center justify-center overflow-hidden relative">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <UserIcon className="w-8 h-8 text-muted-foreground" />
                  )}
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer" onClick={() => fileInputAvatar.current?.click()}>
                    {isUploadingAvatar ? <Loader2 className="w-4 h-4 animate-spin text-white" /> : <Upload className="w-4 h-4 text-white" />}
                  </div>
                </div>
                <input type="file" ref={fileInputAvatar} accept="image/*" className="hidden" onChange={e => e.target.files?.[0] && uploadFile(e.target.files[0], 'avatar')} />

                {/* Status indicator on avatar */}
                <div className={`absolute bottom-1 right-1 w-5 h-5 rounded-full border-4 border-card ${statusOptions.find(s => s.value === status)?.color}`} />
              </div>
            </div>

            {/* Scrollable form content */}
            <div className="px-6 pb-6 relative flex-1 overflow-y-auto">
              <div className="space-y-5">
                <div className="space-y-1">
                  <label className="text-xs font-mono text-muted-foreground uppercase">Nombre de visualización</label>
                  <input 
                    type="text" 
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-sm focus:border-primary focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-mono text-muted-foreground uppercase">Estado actual</label>
                  <div className="grid grid-cols-2 gap-2">
                    {statusOptions.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setStatus(opt.value)}
                        className={`flex items-center gap-2 p-2 rounded-lg border text-sm transition-all ${status === opt.value ? 'bg-primary/10 border-primary/50 text-foreground' : 'border-white/5 bg-background text-muted-foreground hover:bg-white/5'}`}
                      >
                        <div className={`w-3 h-3 rounded-full ${opt.color}`} />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-mono text-muted-foreground uppercase">Biografía cifrada</label>
                  <textarea 
                    value={bio}
                    onChange={e => setBio(e.target.value)}
                    rows={3}
                    className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-sm focus:border-primary focus:outline-none resize-none"
                    placeholder="Información confidencial sobre ti..."
                  />
                </div>
              </div>
              
              <div className="mt-8 flex justify-end gap-3">
                <button onClick={onClose} className="px-4 py-2 text-sm font-medium hover:text-white text-muted-foreground transition-colors">
                  Cancelar
                </button>
                <button 
                  onClick={handleSave}
                  disabled={updateProfile.isPending}
                  className="bg-primary text-primary-foreground px-6 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2"
                >
                  {updateProfile.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Guardar Cambios'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}