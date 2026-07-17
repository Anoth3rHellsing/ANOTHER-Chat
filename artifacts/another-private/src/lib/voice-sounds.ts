/**
 * Programmatic Discord-style voice join/leave sounds using Web Audio API.
 * No audio files needed — tones are generated on the fly.
 */

function playTones(notes: Array<{ freq: number; delay: number; duration: number; volume: number }>) {
  try {
    const ctx = new AudioContext();
    notes.forEach(({ freq, delay, duration, volume }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    });
    // Clean up context after sounds finish
    setTimeout(() => ctx.close().catch(() => {}), (Math.max(...notes.map(n => n.delay + n.duration)) + 0.2) * 1000);
  } catch {
    // AudioContext might be blocked or unavailable
  }
}

/** Short ascending two-note chime — played when you or someone else enters a voice channel. */
export function playVoiceJoinSound() {
  playTones([
    { freq: 523.25, delay: 0,    duration: 0.22, volume: 0.12 }, // C5
    { freq: 659.25, delay: 0.12, duration: 0.28, volume: 0.14 }, // E5
  ]);
}

/** Short descending two-note chime — played when you or someone else leaves a voice channel. */
export function playVoiceLeaveSound() {
  playTones([
    { freq: 659.25, delay: 0,    duration: 0.20, volume: 0.12 }, // E5
    { freq: 523.25, delay: 0.11, duration: 0.26, volume: 0.10 }, // C5
  ]);
}
