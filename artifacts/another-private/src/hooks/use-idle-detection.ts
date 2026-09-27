import { useEffect, useRef, useCallback } from 'react';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 2_000;

type UserStatus = 'online' | 'away' | 'dnd' | 'offline';

interface UseIdleDetectionOptions {
  /** Current user status from the server / local state */
  currentStatus: UserStatus;
  /** Callback to update status on the server */
  onStatusChange: (status: UserStatus) => void;
  /** Whether the user is currently in a voice call (auto-DND handled elsewhere) */
  inCall?: boolean;
  /** Enable/disable the hook */
  enabled?: boolean;
}

export function useIdleDetection({
  currentStatus,
  onStatusChange,
  inCall = false,
  enabled = true,
}: UseIdleDetectionOptions) {
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preCallStatusRef = useRef<UserStatus | null>(null);
  const lastSentStatusRef = useRef<UserStatus>(currentStatus);

  const sendStatus = useCallback(
    (status: UserStatus) => {
      if (!enabled) return;
      if (lastSentStatusRef.current === status) return;
      lastSentStatusRef.current = status;
      onStatusChange(status);
    },
    [enabled, onStatusChange],
  );

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!enabled || inCall) return;

    idleTimerRef.current = setTimeout(() => {
      // Only go away if we're currently online (not dnd/offline set manually)
      if (lastSentStatusRef.current === 'online') {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          sendStatus('away');
        }, DEBOUNCE_MS);
      }
    }, IDLE_TIMEOUT_MS);
  }, [enabled, inCall, sendStatus]);

  const handleActivity = useCallback(() => {
    if (!enabled || inCall) return;

    // Clear pending away transition
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // If we were away, come back online
    if (lastSentStatusRef.current === 'away') {
      sendStatus('online');
    }

    resetIdleTimer();
  }, [enabled, inCall, resetIdleTimer, sendStatus]);

  // Track pre-call status for auto-DND restoration
  useEffect(() => {
    if (inCall && preCallStatusRef.current === null) {
      preCallStatusRef.current = currentStatus;
    } else if (!inCall && preCallStatusRef.current !== null) {
      // Call ended — only restore if user didn't manually change status during the call.
      // If currentStatus differs from what we sent ('dnd'), the user made a manual change
      // and we should respect it instead of overwriting.
      const restored = preCallStatusRef.current;
      preCallStatusRef.current = null;
      const userChangedManually = currentStatus !== 'dnd';
      if (!userChangedManually && restored !== 'offline') {
        sendStatus(restored);
      }
    }
  }, [inCall, currentStatus, sendStatus]);

  // Auto-DND when entering a call
  useEffect(() => {
    if (inCall && enabled && lastSentStatusRef.current !== 'dnd') {
      sendStatus('dnd');
    }
  }, [inCall, enabled, sendStatus]);

  // Set up activity listeners
  useEffect(() => {
    if (!enabled) return;

    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'] as const;
    for (const event of events) {
      window.addEventListener(event, handleActivity, { passive: true });
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        handleActivity();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const handleFocus = () => handleActivity();
    window.addEventListener('focus', handleFocus);

    // Start the idle timer
    resetIdleTimer();

    return () => {
      for (const event of events) {
        window.removeEventListener(event, handleActivity);
      }
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [enabled, handleActivity, resetIdleTimer]);

  // Sync external status changes (e.g., manual status change from settings)
  useEffect(() => {
    if (!inCall) {
      lastSentStatusRef.current = currentStatus;
    }
  }, [currentStatus, inCall]);
}