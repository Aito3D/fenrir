/**
 * useGridReconnect — exponential backoff reconnect logic for the grid stream.
 *
 * Extracted from useGridStream to reduce monolith size.
 */
import { useState, useRef, useCallback } from 'react';
import { RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS } from '../utils/streamConstants';
import { startCountdown } from '../utils/countdown';

interface UseGridReconnectReturn {
  reconnectingSet: Set<number>;
  reconnectCountdown: number;
  reconnectAttempt: number;
  reconnectAttemptsRef: React.MutableRefObject<number>;
  setReconnectingSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  /** Schedule a reconnect with exponential backoff. Returns a promise that resolves after the delay. */
  scheduleReconnect: (printerIds: number[]) => Promise<void>;
  /** Reset all reconnect state (e.g. on successful connection). */
  resetReconnect: () => void;
  /** Clean up any running countdown intervals. */
  cleanupReconnect: () => void;
}

export function useGridReconnect(): UseGridReconnectReturn {
  const [reconnectingSet, setReconnectingSet] = useState<Set<number>>(new Set());
  const [reconnectCountdown, setReconnectCountdown] = useState(0);
  const reconnectAttemptsRef = useRef(0);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const cancelCountdownRef = useRef<(() => void) | null>(null);

  const cleanupReconnect = useCallback(() => {
    cancelCountdownRef.current?.();
    cancelCountdownRef.current = null;
  }, []);

  const resetReconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    setReconnectAttempt(0);
    setReconnectingSet(new Set());
    setReconnectCountdown(0);
    cleanupReconnect();
  }, [cleanupReconnect]);

  const scheduleReconnect = useCallback(async (printerIds: number[]) => {
    const attempt = reconnectAttemptsRef.current;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt),
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttemptsRef.current = attempt + 1;
    setReconnectAttempt(attempt + 1);
    setReconnectingSet(new Set(printerIds));

    // Countdown timer
    cleanupReconnect();
    cancelCountdownRef.current = startCountdown(delay, setReconnectCountdown);

    // Wait then continue
    await new Promise(resolve => setTimeout(resolve, delay));
    cleanupReconnect();
  }, [cleanupReconnect]);

  return {
    reconnectingSet,
    reconnectCountdown,
    reconnectAttempt,
    reconnectAttemptsRef,
    setReconnectingSet,
    scheduleReconnect,
    resetReconnect,
    cleanupReconnect,
  };
}
