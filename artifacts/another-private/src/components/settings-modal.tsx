import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Volume2, Mic, Activity, Video } from 'lucide-react';
import { type AudioVideoSettings, loadSettings, saveSettings, safeCloseAudioContext } from '@/lib/settings-utils';

const SECTIONS = [
  { id: 'voice', label: 'Voz y audio', icon: Volume2 },
  { id: 'video', label: 'Calidad de vídeo', icon: Video },
] as const;

type SectionId = typeof SECTIONS[number]['id'];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AudioVideoSettings;
  onSettingsChange: (s: AudioVideoSettings) => void;
}

export function SettingsModal({ isOpen, onClose, settings, onSettingsChange }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('voice');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [isTesting, setIsTesting] = useState(false);
  const testStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Enumerate devices when opened
  useEffect(() => {
    if (!isOpen) return;
    (async () => {
      try {
        // Request permission first so labels are populated
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(devices.filter(d => d.kind === 'audioinput'));
        setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
      } catch {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(devices.filter(d => d.kind === 'audioinput'));
        setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
      }
    })();
    return () => stopMicTest();
  }, [isOpen]);

  const startMicTest = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: settings.audioInputId ? { deviceId: { exact: settings.audioInputId } } : true,
      });
      testStreamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      setIsTesting(true);

      const tick = () => {
        const buf = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
        setMicLevel(Math.min(100, (avg / 128) * 100));
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      console.error('Mic test failed', err);
    }
  }, [settings.audioInputId]);

  const stopMicTest = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    testStreamRef.current?.getTracks().forEach(t => t.stop());
    testStreamRef.current = null;
    safeCloseAudioContext(audioCtxRef.current);
    audioCtxRef.current = null;
    analyserRef.current = null;
    setIsTesting(false);
    setMicLevel(0);
  }, []);

  const update = (patch: Partial<AudioVideoSettings>) => {
    const next = { ...settings, ...patch };
    onSettingsChange(next);
    saveSettings(next);
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
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className="fixed inset-0 m-auto z-50 w-full max-w-2xl h-fit max-h-[85vh] bg-card border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex"
          >
            {/* Sidebar */}
            <div className="w-52 bg-background/60 border-r border-white/5 flex flex-col flex-shrink-0 py-4">
              <div className="px-4 mb-4">
                <p className="text-xs font-mono text-muted-foreground uppercase tracking-wider">Ajustes</p>
              </div>
              <nav className="flex-1 px-2 space-y-0.5">
                {SECTIONS.map(section => {
                  const Icon = section.icon;
                  return (
                    <button
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                        activeSection === section.id
                          ? 'bg-primary/15 text-primary font-medium'
                          : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {section.label}
                    </button>
                  );
                })}
              </nav>
              <div className="px-4 mt-4 pt-4 border-t border-white/5">
                <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">A.N.O.T.H.E.R.</p>
                <p className="text-[10px] text-muted-foreground font-mono">Terminal Privado</p>
              </div>
            </div>

            {/* Main content */}
            <div className="flex-1 flex flex-col min-h-0">
              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-white/5 flex-shrink-0">
                <h2 className="font-bold text-foreground">
                  {SECTIONS.find(s => s.id === activeSection)?.label}
                </h2>
                <button
                  onClick={onClose}
                  className="p-1.5 text-muted-foreground hover:text-white rounded-lg hover:bg-white/10 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Section content */}
              <div className="flex-1 overflow-y-auto px-6 py-5">
                {activeSection === 'voice' && (
                  <VoiceAudioSection
                    settings={settings}
                    update={update}
                    inputDevices={inputDevices}
                    outputDevices={outputDevices}
                    micLevel={micLevel}
                    isTesting={isTesting}
                    onStartTest={startMicTest}
                    onStopTest={stopMicTest}
                  />
                )}
                {activeSection === 'video' && (
                  <VideoQualitySection settings={settings} update={update} />
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function VoiceAudioSection({
  settings,
  update,
  inputDevices,
  outputDevices,
  micLevel,
  isTesting,
  onStartTest,
  onStopTest,
}: {
  settings: AudioVideoSettings;
  update: (p: Partial<AudioVideoSettings>) => void;
  inputDevices: MediaDeviceInfo[];
  outputDevices: MediaDeviceInfo[];
  micLevel: number;
  isTesting: boolean;
  onStartTest: () => void;
  onStopTest: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* Microphone input */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
          <Mic className="w-3.5 h-3.5" />
          Micrófono de entrada
        </label>
        <select
          value={settings.audioInputId}
          onChange={e => update({ audioInputId: e.target.value })}
          className="w-full bg-secondary border border-white/10 rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer"
        >
          <option value="">Predeterminado del sistema</option>
          {inputDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Micrófono ${d.deviceId.slice(0, 8)}`}</option>
          ))}
        </select>
      </div>

      {/* Mic level meter */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
          <Activity className="w-3.5 h-3.5" />
          Prueba de micrófono
        </label>
        <div className="bg-secondary border border-white/10 rounded-lg p-4 space-y-3">
          <div className="w-full h-2 bg-background rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-green-500 to-green-400 rounded-full transition-all duration-75"
              style={{ width: `${micLevel}%` }}
            />
          </div>
          <button
            onClick={isTesting ? onStopTest : onStartTest}
            className={`text-sm px-4 py-2 rounded-lg font-medium transition-colors ${
              isTesting
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'bg-primary/20 text-primary hover:bg-primary/30'
            }`}
          >
            {isTesting ? 'Detener prueba' : 'Probar micrófono'}
          </button>
          {isTesting && (
            <p className="text-xs text-muted-foreground font-mono animate-pulse">Hablá para ver el nivel...</p>
          )}
        </div>
      </div>

      {/* Audio output */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
          <Volume2 className="w-3.5 h-3.5" />
          Dispositivo de salida de audio
        </label>
        <select
          value={settings.audioOutputId}
          onChange={e => update({ audioOutputId: e.target.value })}
          className="w-full bg-secondary border border-white/10 rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer"
        >
          <option value="">Predeterminado del sistema</option>
          {outputDevices.map(d => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || `Parlante ${d.deviceId.slice(0, 8)}`}</option>
          ))}
        </select>
        {outputDevices.length === 0 && (
          <p className="text-xs text-muted-foreground font-mono">La selección de parlante requiere permisos de audio.</p>
        )}
      </div>

      {/* Volume */}
      <div className="space-y-2">
        <label className="flex items-center justify-between text-xs font-mono text-muted-foreground uppercase tracking-wider">
          <span className="flex items-center gap-2">
            <Volume2 className="w-3.5 h-3.5" />
            Volumen de entrada
          </span>
          <span className="normal-case">{Math.round(settings.volume * 100)}%</span>
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.volume}
          onChange={e => update({ volume: parseFloat(e.target.value) })}
          className="w-full accent-primary h-1.5 rounded-full cursor-pointer"
        />
      </div>

      <div className="rounded-lg bg-secondary/50 border border-white/5 px-4 py-3">
        <p className="text-xs text-muted-foreground font-mono">
          Estas configuraciones se aplican a las llamadas de voz y video. Podés cambiarlas en cualquier momento durante una llamada desde el panel de ajustes.
        </p>
      </div>
    </div>
  );
}

function VideoQualitySection({ settings, update }: { settings: AudioVideoSettings; update: (p: Partial<AudioVideoSettings>) => void }) {
  const qualities = [
    { value: 'low',    label: 'Baja',  desc: '320×240 — 15fps. Mejor para conexiones lentas.' },
    { value: 'medium', label: 'Media', desc: '640×480 — 24fps. Recomendado para la mayoría.' },
    { value: 'high',   label: 'Alta',  desc: '1280×720 — 30fps. HD. Requiere buena conexión.' },
  ] as const;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-xs font-mono text-muted-foreground uppercase tracking-wider">
          <Video className="w-3.5 h-3.5" />
          Calidad de cámara en llamadas
        </label>
        <div className="space-y-2">
          {qualities.map(q => (
            <button
              key={q.value}
              onClick={() => update({ videoQuality: q.value })}
              className={`w-full flex items-start gap-3 px-4 py-3 rounded-xl border transition-all text-left ${
                (settings.videoQuality ?? 'medium') === q.value
                  ? 'border-primary/50 bg-primary/10 text-foreground'
                  : 'border-white/10 bg-secondary hover:border-white/20 text-muted-foreground'
              }`}
            >
              <div className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center ${(settings.videoQuality ?? 'medium') === q.value ? 'border-primary' : 'border-muted-foreground/40'}`}>
                {(settings.videoQuality ?? 'medium') === q.value && <div className="w-2 h-2 rounded-full bg-primary" />}
              </div>
              <div>
                <p className="text-sm font-medium">{q.label}</p>
                <p className="text-xs text-muted-foreground font-mono mt-0.5">{q.desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="rounded-lg bg-secondary/50 border border-white/5 px-4 py-3">
        <p className="text-xs text-muted-foreground font-mono">
          La calidad se aplica cuando activás la cámara en una llamada de voz. La calidad alta puede aumentar el consumo de ancho de banda.
        </p>
      </div>
    </div>
  );
}
