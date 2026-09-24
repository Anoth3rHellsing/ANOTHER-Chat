import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Volume2, Mic, Activity, Video, Bell } from 'lucide-react';
import { useListChannels } from '@workspace/api-client-react';
import { type AudioVideoSettings, saveSettings, safeCloseAudioContext } from '@/lib/settings-utils';
import { type NotificationLevel, type NotificationSettings } from '@/lib/notification-settings';

const SECTIONS = [
  { id: 'voice', label: 'Voz y audio', icon: Volume2 },
  { id: 'video', label: 'Calidad de vídeo', icon: Video },
  { id: 'notifications', label: 'Notificaciones', icon: Bell },
] as const;

type SectionId = typeof SECTIONS[number]['id'];

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AudioVideoSettings;
  onSettingsChange: (s: AudioVideoSettings) => void;
  notificationSettings: NotificationSettings;
  onNotificationSettingsChange: (s: NotificationSettings) => void;
  serverOptions: Array<{ id: number; name: string }>;
  activeServerId?: number | null;
}

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  onSettingsChange,
  notificationSettings,
  onNotificationSettingsChange,
  serverOptions,
  activeServerId,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('voice');
  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [isTesting, setIsTesting] = useState(false);
  const [selectedServerId, setSelectedServerId] = useState<number | null>(activeServerId ?? null);
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);
  const [browserPermission, setBrowserPermission] = useState<'default' | 'granted' | 'denied' | 'unsupported'>('default');
  const testStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const notificationServerId = selectedServerId ?? activeServerId ?? serverOptions[0]?.id ?? null;
  const { data: notificationChannels = [], isLoading: channelsLoading } = useListChannels(
    notificationServerId ?? 0,
    { query: { enabled: isOpen && notificationServerId !== null } as any },
  );

  useEffect(() => {
    if (activeServerId !== undefined) {
      setSelectedServerId(activeServerId);
      setSelectedChannelId(null);
    }
  }, [activeServerId]);

  useEffect(() => {
    if (!isOpen) return;
    setBrowserPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  }, [isOpen]);

  // Opening notification settings must not trigger an unrelated microphone prompt.
  useEffect(() => {
    if (!isOpen || activeSection !== 'voice') return;
    (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setInputDevices(devices.filter(d => d.kind === 'audioinput'));
        setOutputDevices(devices.filter(d => d.kind === 'audiooutput'));
      } catch { /* Device enumeration can be unavailable without a secure context. */ }
    })();
    return () => stopMicTest();
  }, [isOpen, activeSection]);

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

  const updateNotifications = (patch: Partial<NotificationSettings>) => {
    onNotificationSettingsChange({ ...notificationSettings, ...patch });
  };

  const toggleBrowserNotifications = async () => {
    if (browserPermission === 'denied' || browserPermission === 'unsupported') return;
    if (notificationSettings.browserEnabled) {
      updateNotifications({ browserEnabled: false });
      return;
    }

    let permission: NotificationPermission = browserPermission;
    if (permission === 'default') {
      try {
        permission = await Notification.requestPermission();
        setBrowserPermission(permission);
      } catch {
        setBrowserPermission('default');
        return;
      }
    }
    updateNotifications({ browserEnabled: permission === 'granted' });
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
                {activeSection === 'notifications' && (
                  <NotificationSettingsSection
                    settings={notificationSettings}
                    update={updateNotifications}
                    serverOptions={serverOptions}
                    serverId={notificationServerId}
                    channels={notificationChannels}
                    channelsLoading={channelsLoading}
                    selectedChannelId={selectedChannelId}
                    onServerChange={id => {
                      setSelectedServerId(id);
                      setSelectedChannelId(null);
                    }}
                    onChannelChange={setSelectedChannelId}
                    browserPermission={browserPermission}
                    onToggleBrowserNotifications={toggleBrowserNotifications}
                  />
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function NotificationSettingsSection({
  settings,
  update,
  serverOptions,
  serverId,
  channels,
  channelsLoading,
  selectedChannelId,
  onServerChange,
  onChannelChange,
  browserPermission,
  onToggleBrowserNotifications,
}: {
  settings: NotificationSettings;
  update: (patch: Partial<NotificationSettings>) => void;
  serverOptions: Array<{ id: number; name: string }>;
  serverId: number | null;
  channels: Array<{ id: number; name: string }>;
  channelsLoading: boolean;
  selectedChannelId: number | null;
  onServerChange: (id: number | null) => void;
  onChannelChange: (id: number | null) => void;
  browserPermission: 'default' | 'granted' | 'denied' | 'unsupported';
  onToggleBrowserNotifications: () => void;
}) {
  const serverLevel = serverId === null
    ? 'mentions'
    : settings.serverLevels[String(serverId)] ?? 'mentions';
  const channelLevel = selectedChannelId === null
    ? ''
    : settings.channelLevels[String(selectedChannelId)] ?? '';
  const muteIsActive = settings.muteUntil !== null && settings.muteUntil > Date.now();

  const setServerLevel = (level: NotificationLevel) => {
    if (serverId === null) return;
    update({ serverLevels: { ...settings.serverLevels, [String(serverId)]: level } });
  };

  const setChannelLevel = (level: NotificationLevel | '') => {
    if (selectedChannelId === null) return;
    const channelLevels = { ...settings.channelLevels };
    if (level === '') delete channelLevels[String(selectedChannelId)];
    else channelLevels[String(selectedChannelId)] = level;
    update({ channelLevels });
  };

  const setMuteDuration = (hours: number | null) => {
    update({ muteUntil: hours === null ? null : Date.now() + hours * 60 * 60 * 1000 });
  };

  const permissionDescription = {
    default: 'Aún no se ha solicitado permiso del navegador.',
    granted: 'El navegador permite las notificaciones.',
    denied: 'El navegador bloqueó las notificaciones.',
    unsupported: 'Este navegador no admite notificaciones.',
  }[browserPermission];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Notificaciones por servidor</h3>
        <p className="text-xs text-muted-foreground">El valor predeterminado es solo menciones. Los mensajes directos siempre notifican.</p>
        <label className="block text-xs font-mono text-muted-foreground uppercase tracking-wider" htmlFor="notification-server">
          Servidor
        </label>
        <select
          id="notification-server"
          data-testid="select-notification-server"
          value={serverId ?? ''}
          onChange={event => onServerChange(event.target.value ? Number(event.target.value) : null)}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer"
        >
          <option value="">Elegir servidor</option>
          {serverOptions.map(server => (
            <option key={server.id} value={server.id}>{server.name}</option>
          ))}
        </select>
        <label className="block text-xs font-mono text-muted-foreground uppercase tracking-wider" htmlFor="notification-server-level">
          Nivel de notificación
        </label>
        <select
          id="notification-server-level"
          data-testid="select-notification-server-level"
          value={serverLevel}
          disabled={serverId === null}
          onChange={event => setServerLevel(event.target.value as NotificationLevel)}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer disabled:opacity-50"
        >
          <option value="all">Todos los mensajes</option>
          <option value="mentions">Solo menciones</option>
          <option value="none">Ninguno</option>
        </select>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-foreground">Excepción por canal</h3>
        <label className="block text-xs font-mono text-muted-foreground uppercase tracking-wider" htmlFor="notification-channel">
          Canal
        </label>
        <select
          id="notification-channel"
          data-testid="select-notification-channel"
          value={selectedChannelId ?? ''}
          disabled={serverId === null || channelsLoading || channels.length === 0}
          onChange={event => onChannelChange(event.target.value ? Number(event.target.value) : null)}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer disabled:opacity-50"
        >
          <option value="">
            {channelsLoading ? 'Cargando canales…' : channels.length ? 'Elegir canal' : 'No hay canales disponibles'}
          </option>
          {channels.map(channel => (
            <option key={channel.id} value={channel.id}>#{channel.name}</option>
          ))}
        </select>
        <label className="block text-xs font-mono text-muted-foreground uppercase tracking-wider" htmlFor="notification-channel-level">
          Nivel del canal
        </label>
        <select
          id="notification-channel-level"
          data-testid="select-notification-channel-level"
          value={channelLevel}
          disabled={selectedChannelId === null}
          onChange={event => setChannelLevel(event.target.value as NotificationLevel | '')}
          className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-primary cursor-pointer disabled:opacity-50"
        >
          <option value="">Heredar del servidor</option>
          <option value="all">Todos los mensajes</option>
          <option value="mentions">Solo menciones</option>
          <option value="none">Ninguno</option>
        </select>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Silencio global</h3>
        {muteIsActive ? (
          <p data-testid="status-global-mute" className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
            Notificaciones silenciadas hasta {new Date(settings.muteUntil as number).toLocaleString()}.
          </p>
        ) : (
          <p data-testid="status-global-mute" className="text-xs text-muted-foreground">El silencio global está desactivado.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {([
            { hours: 1, label: '1 hora' },
            { hours: 8, label: '8 horas' },
            { hours: 24, label: '24 horas' },
          ] as const).map(option => (
            <button
              key={option.hours}
              type="button"
              data-testid={`button-mute-${option.hours}h`}
              onClick={() => setMuteDuration(option.hours)}
              className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground hover:border-primary/50 hover:text-primary transition-colors"
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            data-testid="button-mute-off"
            onClick={() => setMuteDuration(null)}
            className="rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground hover:border-primary/50 hover:text-primary transition-colors"
          >
            Desactivar
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Preferencias</h3>
        <button
          type="button"
          data-testid="toggle-notification-sound"
          aria-pressed={settings.soundEnabled}
          onClick={() => update({ soundEnabled: !settings.soundEnabled })}
          className="w-full flex items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3 text-left text-sm text-foreground hover:border-primary/30"
        >
          <span>Sonido de notificación</span>
          <span className="text-xs text-muted-foreground">{settings.soundEnabled ? 'Activado' : 'Desactivado'}</span>
        </button>
        <button
          type="button"
          data-testid="toggle-notification-preview"
          aria-pressed={settings.showPreview}
          onClick={() => update({ showPreview: !settings.showPreview })}
          className="w-full flex items-center justify-between rounded-lg border border-border bg-secondary px-3 py-3 text-left text-sm text-foreground hover:border-primary/30"
        >
          <span>Mostrar vista previa del mensaje</span>
          <span className="text-xs text-muted-foreground">{settings.showPreview ? 'Activado' : 'Desactivado'}</span>
        </button>
        <p className="text-xs text-muted-foreground">Desactiva la vista previa para ocultar el contenido de los mensajes en las notificaciones.</p>
      </div>

      <div className="space-y-2 rounded-xl border border-border bg-secondary/50 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Notificaciones del navegador</h3>
            <p data-testid="status-browser-notifications" className="mt-1 text-xs text-muted-foreground">{permissionDescription}</p>
          </div>
          <button
            type="button"
            data-testid="toggle-browser-notifications"
            aria-pressed={settings.browserEnabled && browserPermission === 'granted'}
            disabled={!settings.browserEnabled && (browserPermission === 'denied' || browserPermission === 'unsupported')}
            onClick={onToggleBrowserNotifications}
            className="shrink-0 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary hover:bg-primary/20 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {settings.browserEnabled ? 'Desactivar' : browserPermission === 'denied' ? 'Bloqueado' : 'Activar'}
          </button>
        </div>
        {browserPermission === 'denied' && (
          <p data-testid="text-browser-notification-help" className="text-xs text-muted-foreground">
            El permiso fue denegado. Para habilitarlo, cambia el permiso de notificaciones de este sitio desde la configuración del navegador y vuelve a cargar la página.
          </p>
        )}
        {browserPermission === 'default' && (
          <p className="text-xs text-muted-foreground">Al pulsar Activar, el navegador te pedirá permiso. No se solicitará hasta que elijas esta opción.</p>
        )}
      </div>
    </div>
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
