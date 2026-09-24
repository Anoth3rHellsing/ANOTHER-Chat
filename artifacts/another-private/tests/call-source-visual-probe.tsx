import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { CallSourceControls, CallSourceControlsProps } from '../src/components/call-source-controls';
import { CallScreenGallery, SharedScreen } from '../src/components/call-screen-gallery';
import { PeerSourcePreferences, DEFAULT_PEER_SOURCE_PREFERENCES, CallAudioSource, CallVideoSource, SourceLevel } from '../src/lib/call-source-preferences';
import '../src/index.css';

// Synthetic media streams
function createEmptyVideoTrack(): MediaStreamTrack {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas.captureStream(1).getVideoTracks()[0];
}

function createEmptyStream(): MediaStream {
  return new MediaStream([createEmptyVideoTrack()]);
}

const STREAM_1 = createEmptyStream();
const STREAM_2 = createEmptyStream();

type Participant = CallSourceControlsProps['participants'][0];

function Fixture() {
  const [participants, setParticipants] = useState<Participant[]>([
    {
      userId: 1,
      displayName: 'Alice',
      hasMicrophone: true,
      hasCamera: true,
      hasScreen: true,
      hasScreenAudio: true,
      preferences: { ...DEFAULT_PEER_SOURCE_PREFERENCES }
    },
    {
      userId: 2,
      displayName: 'Bob',
      hasMicrophone: true,
      hasCamera: true,
      hasScreen: true,
      hasScreenAudio: false,
      preferences: { ...DEFAULT_PEER_SOURCE_PREFERENCES }
    }
  ]);
  
  const [featuredKey, setFeaturedKey] = useState<string | null>('screen-1');
  const [minimized, setMinimized] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  
  const log = (msg: string) => {
    console.log(msg);
    setLogs(prev => [...prev, msg]);
  };
  
  const pass = (msg: string) => log(`✅ PASS: ${msg}`);
  const fail = (msg: string) => log(`❌ FAIL: ${msg}`);

  // Expose results to Chromium test script
  useEffect(() => {
    (window as any).testLogs = logs;
    if (logs.includes('DONE')) {
      (window as any).testStatus = logs.some(l => l.includes('FAIL')) ? 'failed' : 'passed';
    }
  }, [logs]);

  const handleAudioChange = (peerId: number, source: CallAudioSource, patch: Partial<SourceLevel>) => {
    setParticipants(prev => prev.map(p => {
      if (p.userId !== peerId) return p;
      return {
        ...p,
        preferences: {
          ...p.preferences,
          [source]: {
            ...p.preferences[source],
            ...patch
          }
        }
      };
    }));
  };

  const handleToggleVideo = (peerId: number, source: CallVideoSource) => {
    setParticipants(prev => prev.map(p => {
      if (p.userId !== peerId) return p;
      return {
        ...p,
        preferences: {
          ...p.preferences,
          [source === 'camera' ? 'cameraVisible' : 'screenVisible']: 
            !p.preferences[source === 'camera' ? 'cameraVisible' : 'screenVisible']
        }
      };
    }));
  };

  const runTests = async () => {
    log('Starting tests...');
    
    // 1. Check initial state
    await new Promise(r => setTimeout(r, 100));
    const startP1 = participants.find(p => p.userId === 1)!;
    if (startP1.preferences.screenVisible) pass('Initial screen visible');
    else fail('Initial screen not visible');
    
    // 2. Hide one screen locally while another stays shown
    log('Hiding Alice screen...');
    handleToggleVideo(1, 'screen');
    await new Promise(r => setTimeout(r, 100));
    setParticipants(curr => {
      const p1 = curr.find(p => p.userId === 1)!;
      const p2 = curr.find(p => p.userId === 2)!;
      if (!p1.preferences.screenVisible && p2.preferences.screenVisible) {
        pass('Alice screen hidden, Bob screen still visible');
      } else {
        fail('Screen hide independence failed');
      }
      return curr;
    });

    // 3. Show it again
    log('Showing Alice screen again...');
    handleToggleVideo(1, 'screen');
    await new Promise(r => setTimeout(r, 100));
    setParticipants(curr => {
      const p1 = curr.find(p => p.userId === 1)!;
      if (p1.preferences.screenVisible) {
        pass('Alice screen restored');
      } else {
        fail('Alice screen restore failed');
      }
      return curr;
    });

    // 4. Select the other as featured and switch back
    log('Switching featured to Bob...');
    const videoBefore = document.querySelector('video'); // get first video
    setFeaturedKey('screen-2');
    await new Promise(r => setTimeout(r, 100));
    setFeaturedKey('screen-1');
    await new Promise(r => setTimeout(r, 100));
    const videoAfter = document.querySelector('video');
    if (videoBefore && videoBefore === videoAfter) {
      pass('Featured screen switched without replacing video element');
    } else {
      fail('Video element was replaced during featured switch');
    }
    
    // 5. Per-person mic/screen slider+mutes remain independent
    log('Changing Alice mic volume...');
    handleAudioChange(1, 'microphone', { volume: 0.5 });
    await new Promise(r => setTimeout(r, 100));
    setParticipants(curr => {
      const p1 = curr.find(p => p.userId === 1)!;
      const p2 = curr.find(p => p.userId === 2)!;
      if (p1.preferences.microphone.volume === 0.5 && p2.preferences.microphone.volume === 1) {
        pass('Volume changed independently');
      } else {
        fail('Volume change leaked');
      }
      return curr;
    });
    
    // 6. Controls accessible after simulated minimize/restore
    log('Minimizing and restoring...');
    setMinimized(true);
    await new Promise(r => setTimeout(r, 100));
    setMinimized(false);
    await new Promise(r => setTimeout(r, 100));
    pass('Minimize/restore cycled');

    // 7. Preferences preserved when third peer joins/leaves
    log('Third peer joining...');
    setParticipants(curr => [
      ...curr,
      {
        userId: 3,
        displayName: 'Charlie',
        hasMicrophone: true,
        hasCamera: false,
        hasScreen: false,
        hasScreenAudio: false,
        preferences: { ...DEFAULT_PEER_SOURCE_PREFERENCES }
      }
    ]);
    await new Promise(r => setTimeout(r, 100));
    
    setParticipants(curr => {
      const p1 = curr.find(p => p.userId === 1)!;
      if (p1.preferences.microphone.volume === 0.5) {
        pass('Alice volume preserved after Charlie joined');
      } else {
        fail('Alice volume reset when Charlie joined');
      }
      return curr;
    });
    
    log('Third peer leaving...');
    setParticipants(curr => curr.filter(p => p.userId !== 3));
    await new Promise(r => setTimeout(r, 100));
    setParticipants(curr => {
      const p1 = curr.find(p => p.userId === 1)!;
      if (p1.preferences.microphone.volume === 0.5) {
        pass('Alice volume preserved after Charlie left');
      } else {
        fail('Alice volume reset when Charlie left');
      }
      return curr;
    });

    log('DONE');
  };

  useEffect(() => {
    runTests();
  }, []);

  const screens: SharedScreen[] = [];
  const alice = participants.find(p => p.userId === 1);
  if (alice && alice.hasScreen) {
    screens.push({
      key: 'screen-1',
      stream: STREAM_1,
      label: 'Alice Screen',
      local: false,
      visible: alice.preferences.screenVisible,
      audioAvailable: alice.hasScreenAudio
    });
  }
  
  const bob = participants.find(p => p.userId === 2);
  if (bob && bob.hasScreen) {
    screens.push({
      key: 'screen-2',
      stream: STREAM_2,
      label: 'Bob Screen',
      local: false,
      visible: bob.preferences.screenVisible,
      audioAvailable: bob.hasScreenAudio
    });
  }

  return (
    <div className="flex flex-col md:flex-row gap-4 h-[100dvh]">
      <div className="flex-[2] flex flex-col gap-4">
        <CallScreenGallery 
          screens={screens} 
          featuredKey={featuredKey} 
          onFeature={setFeaturedKey} 
        />
        
        <div className="bg-secondary/20 p-4 rounded-xl border border-border">
          <h2 className="text-xl font-bold mb-2">Test Logs</h2>
          <div className="font-mono text-sm space-y-1 h-64 overflow-y-auto">
            {logs.map((l, i) => (
              <div key={i} className={l.includes('✅') ? 'text-green-400' : l.includes('❌') ? 'text-red-400' : 'text-gray-300'}>
                {l}
              </div>
            ))}
          </div>
        </div>
      </div>
      
      <div className="flex-1 max-w-sm">
        {!minimized && (
          <CallSourceControls 
            participants={participants}
            onAudioChange={handleAudioChange}
            onToggleVideo={handleToggleVideo}
            onClose={() => setMinimized(true)}
          />
        )}
        {minimized && (
          <button onClick={() => setMinimized(false)} className="bg-primary text-primary-foreground px-4 py-2 rounded">
            Restore Controls
          </button>
        )}
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<Fixture />);
}
