import { useEffect, useCallback } from 'react';
import { getAuthToken } from '../api/client';

/**
 * Sends a camera stop hint to the backend on unmount and beforeunload.
 * Prevents orphaned ffmpeg processes when the viewer navigates away.
 */
export function useCameraStopHint(printerId: number, viewerId?: string) {
  const sendStop = useCallback(() => {
    if (printerId <= 0) return;
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // With the viewer id the stop ends this viewer's own external camera
    // stream and leaves other viewers' running; without one, every stream of
    // the printer (as before).
    const query = viewerId ? `?viewer=${viewerId}` : '';
    fetch(`/api/v1/printers/${printerId}/camera/stop${query}`, {
      method: 'POST',
      keepalive: true,
      headers,
    }).catch(() => {});
  }, [printerId, viewerId]);

  useEffect(() => {
    if (printerId <= 0) return;
    window.addEventListener('beforeunload', sendStop);
    return () => {
      window.removeEventListener('beforeunload', sendStop);
      sendStop();
    };
  }, [printerId, sendStop]);
}
