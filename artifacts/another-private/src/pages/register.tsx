import { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { useRegister } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Terminal, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';

function getAuthErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const apiError = error as { status?: number; data?: unknown };
    if (typeof apiError.data === 'object' && apiError.data !== null) {
      const message = (apiError.data as { error?: unknown }).error;
      if (typeof message === 'string' && message.trim()) return message;
    }
    if (apiError.status === 429) {
      return 'Demasiadas solicitudes. Inténtalo de nuevo más tarde.';
    }
  }
  return 'No se pudo completar el registro. Inténtalo de nuevo más tarde.';
}

export default function Register() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const register = useRegister();
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    register.mutate({ data: { username, password, displayName, inviteCode: inviteCode || undefined } }, {
      onSuccess: () => {
        toast({ title: "Registro completado", description: "Acceso concedido." });
        setLocation('/app');
      },
      onError: (error) => {
        toast({ title: "Error de registro", description: getAuthErrorMessage(error), variant: "destructive" });
      }
    });
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      
      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-md p-8 relative z-10"
      >
        <div className="text-center mb-8">
          <Terminal className="w-10 h-10 text-primary mx-auto mb-4" />
          <h1 className="text-3xl font-bold font-mono tracking-tight text-foreground">Alta de Operario</h1>
          <p className="text-muted-foreground mt-2 text-sm">Establecer nueva identidad en A.N.O.T.H.E.R.</p>
        </div>

        <div className="bg-card/50 backdrop-blur-xl border border-white/5 p-8 rounded-2xl shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Identificación (Username)</label>
              <input 
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full bg-background border border-white/10 rounded-lg px-4 py-2.5 text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all font-mono text-sm"
                placeholder="usuario_secreto"
                required
                minLength={3}
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Nombre Público (Display Name)</label>
              <input 
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                className="w-full bg-background border border-white/10 rounded-lg px-4 py-2.5 text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all font-sans text-sm"
                placeholder="Agente X"
                required
                minLength={1}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Clave de acceso</label>
              <input 
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full bg-background border border-white/10 rounded-lg px-4 py-2.5 text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all font-mono text-sm"
                placeholder="Mínimo 8 caracteres"
                required
                minLength={8}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Código de Invitación</label>
              <input 
                type="text"
                value={inviteCode}
                onChange={e => setInviteCode(e.target.value)}
                className="w-full bg-background border border-white/10 rounded-lg px-4 py-2.5 text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all font-mono text-sm uppercase"
                placeholder="Dejar vacío si eres el primero"
              />
            </div>

            <button 
              type="submit" 
              disabled={register.isPending}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-medium px-4 py-3 rounded-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 mt-6"
            >
              {register.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'GENERAR IDENTIDAD'}
            </button>
          </form>

          <div className="mt-6 text-center border-t border-white/5 pt-6">
            <p className="text-sm text-muted-foreground">
              ¿Ya tienes acceso?{' '}
              <Link href="/" className="text-primary hover:text-primary/80 transition-colors font-medium">
                Conectar
              </Link>
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}