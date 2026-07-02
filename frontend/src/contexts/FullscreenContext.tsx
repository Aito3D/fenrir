import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';

interface FullscreenContextType {
  /** In-app fullscreen (kiosk) mode — hides nav chrome, banners, and the bug report bubble. */
  fullscreen: boolean;
  setFullscreen: (value: boolean) => void;
  toggleFullscreen: () => void;
}

const FullscreenContext = createContext<FullscreenContextType | undefined>(undefined);

export function FullscreenProvider({ children }: { children: ReactNode }) {
  const [fullscreen, setFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => setFullscreen(prev => !prev), []);

  // Escape exits fullscreen (unless typing in an input)
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      setFullscreen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  const value = useMemo(
    () => ({ fullscreen, setFullscreen, toggleFullscreen }),
    [fullscreen, toggleFullscreen],
  );

  return <FullscreenContext.Provider value={value}>{children}</FullscreenContext.Provider>;
}

export function useFullscreen(): FullscreenContextType {
  const context = useContext(FullscreenContext);
  if (!context) {
    throw new Error('useFullscreen must be used within a FullscreenProvider');
  }
  return context;
}
