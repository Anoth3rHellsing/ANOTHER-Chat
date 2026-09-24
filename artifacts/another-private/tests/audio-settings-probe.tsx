// Visual/interaction fixture only; this profile has no account or server data.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsModal } from '../src/components/settings-modal';
import { loadSettings } from '../src/lib/settings-utils';
import { loadNotificationSettings } from '../src/lib/notification-settings';
import '../src/index.css';

function Probe() {
  const [settings, setSettings] = useState(() => loadSettings(700003));
  const [notifications, setNotifications] = useState(() => loadNotificationSettings(700003));
  const [soundboard, setSoundboard] = useState({ volume: 1, muted: false });
  return <SettingsModal isOpen onClose={() => {}} settings={settings} onSettingsChange={setSettings}
    currentUserId={700003} notificationSettings={notifications}
    onNotificationSettingsChange={setNotifications}
    soundboardSettings={soundboard} onSoundboardSettingsChange={setSoundboard}
    serverOptions={[]} activeServerId={null} />;
}

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}><Probe /></QueryClientProvider>,
);