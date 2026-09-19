import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { csrfFetch, useUpdateMyProfile, getGetCurrentUserQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Upload, CheckCircle2, Circle, Loader2, User as UserIcon, Plus, Trash2, Instagram, Youtube, Twitch, Github, ExternalLink } from 'lucide-react';
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

const SOCIAL_PLATFORMS = [
  { value: 'instagram', label: 'Instagram', icon: Instagram, placeholder: 'https://instagram.com/usuario' },
  { value: 'twitter',   label: 'X / Twitter', icon: (props: any) => (
    <svg viewBox="0 0 24 24" {...props} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.911-5.622Zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  ), placeholder: 'https://x.com/usuario' },
  { value: 'youtube',  label: 'YouTube', icon: Youtube, placeholder: 'https://youtube.com/@canal' },
  { value: 'twitch',   label: 'Twitch', icon: Twitch, placeholder: 'https://twitch.tv/usuario' },
  { value: 'github',   label: 'GitHub', icon: Github, placeholder: 'https://github.com/usuario' },
  { value: 'custom',   label: 'Enlace personalizado', icon: ExternalLink, placeholder: 'https://...' },
] as const;

interface SocialLink {
  platform: string;
  url: string;
  label: string;
}

export function ProfileModal({ user, isOpen, onClose }: ProfileModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateProfile = useUpdateMyProfile();
  
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio || '');
  const [status, setStatus] = useState<any>(user.status);
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>((user as any).socialLinks ?? []);
  
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
      setSocialLinks((user as any).socialLinks ?? []);
    }
  }, [isOpen, user]);

  const handleSave = () => {
    updateProfile.mutate({ data: { displayName, bio, status, socialLinks: socialLinks as any } }, {
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
      const res = await csrfFetch(`${baseUrl}/api/users/me/${type}`, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      
      if (!res.ok) throw new Error("Error en la subida");
      const data = await res.json();
      if (type === 'avatar') setAvatarUrl(data.url);
      else setBannerUrl(data.url);
      
      queryClient.setQueryData(getGetCurrentUserQueryKey(), (old: any) => {
        if (!old) return old;
        return { ...old, [type === 'avatar' ? 'avatarUrl' : 'bannerUrl']: data.url };
      });
      
      toast({ title: "Imagen actualizada" });
    } catch {
      toast({ title: "Error al subir la imagen", variant: "destructive" });
    } finally {
      if (type === 'avatar') setIsUploadingAvatar(false);
      else setIsUploadingBanner(false);
    }
  };

  const addSocialLink = (platform: string) => {
    if (socialLinks.some(l => l.platform === platform && platform !== 'custom')) return;
    setSocialLinks(prev => [...prev, { platform, url: '', label: '' }]);
  };

  const updateLink = (idx: number, field: 'url' | 'label', value: string) => {
    setSocialLinks(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  const removeLink = (idx: number) => {
    setSocialLinks(prev => prev.filter((_, i) => i !== idx));
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
            className="fixed inset-0 m-auto z-50 w-full max-w-lg h-fit max-h-[90vh] bg-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col"
          >
            {/* Header / Banner Area */}
            <div className="relative h-32 bg-secondary flex items-center justify-center overflow-hidden group flex-shrink-0">
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

            {/* Avatar */}
            <div className="px-6 pt-0 relative z-10 flex-shrink-0">
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
                <div className={`absolute bottom-1 right-1 w-5 h-5 rounded-full border-4 border-card ${statusOptions.find(s => s.value === status)?.color}`} />
              </div>
            </div>

            {/* Scrollable form content */}
            <div className="px-6 pb-6 flex-1 overflow-y-auto">
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

                {/* Social links section */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-mono text-muted-foreground uppercase">Redes sociales</label>
                  </div>

                  {/* Existing links */}
                  {socialLinks.length > 0 && (
                    <div className="space-y-2">
                      {socialLinks.map((link, idx) => {
                        const platform = SOCIAL_PLATFORMS.find(p => p.value === link.platform);
                        const Icon = platform?.icon ?? ExternalLink;
                        return (
                          <div key={idx} className="flex items-center gap-2 bg-background border border-white/10 rounded-lg px-3 py-2">
                            <Icon className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <input
                              type="url"
                              value={link.url}
                              onChange={e => updateLink(idx, 'url', e.target.value)}
                              placeholder={platform?.placeholder ?? 'https://...'}
                              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none min-w-0"
                            />
                            {link.platform === 'custom' && (
                              <input
                                type="text"
                                value={link.label}
                                onChange={e => updateLink(idx, 'label', e.target.value)}
                                placeholder="Etiqueta"
                                className="w-24 bg-transparent text-xs text-muted-foreground placeholder:text-muted-foreground/50 focus:outline-none border-l border-white/10 pl-2"
                              />
                            )}
                            <button onClick={() => removeLink(idx)} className="text-muted-foreground hover:text-destructive transition-colors flex-shrink-0">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Add platform buttons */}
                  <div className="flex flex-wrap gap-2">
                    {SOCIAL_PLATFORMS.map(p => {
                      const Icon = p.icon;
                      const alreadyAdded = p.value !== 'custom' && socialLinks.some(l => l.platform === p.value);
                      return (
                        <button
                          key={p.value}
                          onClick={() => addSocialLink(p.value)}
                          disabled={alreadyAdded}
                          title={p.label}
                          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-all ${alreadyAdded ? 'border-primary/40 bg-primary/10 text-primary/50 cursor-default' : 'border-white/10 bg-background text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5'}`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          {alreadyAdded ? '✓' : <Plus className="w-2.5 h-2.5" />}
                        </button>
                      );
                    })}
                  </div>
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
