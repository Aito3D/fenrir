import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';

interface FullscreenContextType {
  /** In-app fullscreen (kiosk) mode — hides nav chrome, banners, and the bug report bubble. */
  fullscreen: boolean;
  setFullscreen: (value: boolean) => void;
  toggleFullscreen: () => void;
}

const FullscreenContext = createContext<FullscreenContextType | undefined>(undefined);

const FULLSCREEN_STORAGE_KEY = 'printersFullscreen';

function readStoredFullscreen(): boolean {
  try {
    return localStorage.getItem(FULLSCREEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistFullscreen(value: boolean): void {
  try {
    localStorage.setItem(FULLSCREEN_STORAGE_KEY, String(value));
  } catch {
    // Storage unavailable (private mode / quota) — persistence is best-effort.
  }
}

export function FullscreenProvider({ children }: { children: ReactNode }) {
  // Persisted so fullscreen survives a page reload. It is scoped to the
  // printers page in practice: that's the only page with a toggle, and Layout
  // clears it when navigating to any other page (which also updates storage).
  const [fullscreen, setFullscreenState] = useState(readStoredFullscreen);

  const setFullscreen = useCallback((value: boolean) => {
    persistFullscreen(value);
    setFullscreenState(value);
  }, []);

  const toggleFullscreen = useCallback(() => {
    setFullscreenState(prev => {
      const next = !prev;
      persistFullscreen(next);
      return next;
    });
  }, []);

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
  }, [fullscreen, setFullscreen]);

  const value = useMemo(
    () => ({ fullscreen, setFullscreen, toggleFullscreen }),
    [fullscreen, setFullscreen, toggleFullscreen],
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
