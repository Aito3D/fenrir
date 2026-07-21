import { useRef, memo } from 'react';

import { useWebRTCStream } from '../../hooks/useWebRTCStream';
import type { WebRTCPrinterStats } from '../../hooks/useWebRTCStream';
import { CameraGridCard } from './CameraGridCard';
import type { GridCardBaseProps } from './CameraGridCard';

export interface WebRTCGridCardProps extends GridCardBaseProps {
  onStats?: (id: number, stats: WebRTCPrinterStats) => void;
  restartKey?: number;
  /** Tab hidden — tear down the WebRTC connection to save CPU/bandwidth. */
  suspended?: boolean;
}

/**
 * WebRTCGridCard — wraps CameraGridCard with an individual useWebRTCStream connection.
 * Used for RTSP-capable printers when camera_engine is 'go2rtc'.
 */
export const WebRTCGridCard = memo(function WebRTCGridCard({ onStats, restartKey, suspended, ...cardProps }: WebRTCGridCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const {
    isLoading,
    hasError,
    isReconnecting,
    reconnectCountdown,
    reconnectAttempt,
    stale,
    degraded,
    restart,
  } = useWebRTCStream({
    printerId: cardProps.printerId,
    enabled: cardProps.connected && !suspended,
    videoRef,
    onStats,
    restartKey,
  });

  return (
    <CameraGridCard
      {...cardProps}
      videoRef={videoRef}
      loading={isLoading}
      error={hasError}
      reconnecting={isReconnecting}
      reconnectCountdown={reconnectCountdown}
      reconnectAttempt={reconnectAttempt}
      degraded={degraded}
      stale={stale}
      onRestart={restart}
    />
  );
});
