import { useState, useRef, useEffect } from 'react';
import { useLocation, Link } from 'wouter';
import { useLogin } from '@workspace/api-client-react';
import { useToast } from '@/hooks/use-toast';
import { Shield, KeyRound, Loader2 } from 'lucide-react';
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
  return 'No se pudo conectar. Inténtalo de nuevo más tarde.';
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const login = useLogin();
  
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate({ data: { username, password } }, {
      onSuccess: () => {
        toast({ title: "Acceso concedido", description: "Iniciando conexión segura..." });
        setLocation('/app');
      },
      onError: (error) => {
        toast({ title: "Acceso denegado", description: getAuthErrorMessage(error), variant: "destructive" });
      }
    });
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background relative overflow-hidden">
      {/* Background ambient glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-md p-8 relative z-10"
      >
        <div className="text-center mb-10">
          <Shield className="w-12 h-12 text-primary mx-auto mb-4 glow-effect rounded-full" />
          <h1 className="text-4xl font-bold font-mono tracking-tight text-foreground glow-text">A.N.O.T.H.E.R.</h1>
          <p className="text-muted-foreground mt-2 uppercase tracking-widest text-sm font-semibold">Private Terminal</p>
        </div>

        <div className="bg-card/50 backdrop-blur-xl border border-white/5 p-8 rounded-2xl shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Identificación</label>
              <input 
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                className="w-full bg-background border border-white/10 rounded-lg px-4 py-3 text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all font-mono"
                placeholder="Nombre de usuario"
                required
              />
            </div>
            
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Clave de acceso</label>
              <div className="relative">
                <input 
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full bg-background border border-white/10 rounded-lg px-4 py-3 text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all font-mono"
                  placeholder="••••••••"
                  required
                />
                <KeyRound className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              </div>
            </div>

            <button 
              type="submit" 
              disabled={login.isPending}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-medium px-4 py-3 rounded-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2 mt-4"
            >
              {login.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : 'CONECTAR'}
            </button>
          </form>

          <div className="mt-8 text-center border-t border-white/5 pt-6">
            <p className="text-sm text-muted-foreground">
              ¿No tienes autorización?{' '}
              <Link href="/register" className="text-primary hover:text-primary/80 transition-colors font-medium">
                Solicitar acceso
              </Link>
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}