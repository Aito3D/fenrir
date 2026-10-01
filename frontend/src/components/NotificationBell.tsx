import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bell, BellRing } from 'lucide-react';
import { api, type InboxItem, type InboxPage, type InboxPreferences } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { chime } from '../utils/chime';
import { inboxTarget } from '../utils/inboxTarget';
import { kindFamily } from './notificationKinds';
import { NotificationPanel } from './NotificationPanel';

const INBOX_KEY = ['inbox'];
const PREFS_KEY = ['inbox-preferences'];
/** The mobile top bar is h-14: a bell above this line opens its panel downwards. */
const TOP_BAR_PX = 56;
/** The panel is 24rem wide. The app's root rem is not 16px, so it is read, not assumed. */
const panelPx = () => 24 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

/** The inbox bell. Rendered only for a signed-in user: with auth off there is no inbox. */
export function NotificationBell() {
  const { authEnabled, user } = useAuth();
  if (!authEnabled || !user) return null;
  return <SignedInBell />;
}

function SignedInBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  // Bumped per arrival: remounts the ring and the badge so both replay.
  const [arrivals, setArrivals] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});

  const { data: inbox } = useQuery({
    queryKey: INBOX_KEY,
    queryFn: () => api.getInbox(),
    refetchOnWindowFocus: true,
  });
  const { data: prefs } = useQuery({ queryKey: PREFS_KEY, queryFn: api.getInboxPreferences });
  const unread = inbox?.unread ?? 0;

  // Arrival: the first page sets the baseline; a later page with a newer
  // unread row rings the bell, and chimes when that row's kind rings.
  const lastSeenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!inbox) return;
    const last = lastSeenRef.current;
    lastSeenRef.current = Math.max(last ?? 0, inbox.items[0]?.id ?? 0);
    if (last === null) return;
    const fresh = inbox.items.filter((i) => i.id > last && i.read_at === null);
    if (fresh.length === 0) return;
    setRinging(true);
    setArrivals((n) => n + 1);
    const soundKinds = queryClient.getQueryData<InboxPreferences>(PREFS_KEY)?.sound_kinds ?? [];
    if (fresh.some((i) => soundKinds.includes(i.kind))) chime();
  }, [inbox, queryClient]);

  useEffect(() => {
    if (!ringing) return;
    const timer = window.setTimeout(() => setRinging(false), 1000);
    return () => window.clearTimeout(timer);
  }, [ringing, arrivals]);

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = panelPx();
    if (r.top < TOP_BAR_PX) {
      setPos({
        top: r.bottom + 8,
        right: Math.max(8, window.innerWidth - r.right),
        width: Math.min(width, window.innerWidth - 16),
      });
    } else {
      // Beside the sidebar, bottom-aligned with the bell. It floats over the
      // left edge of the page, which the scrim keeps inert until it closes.
      const left = r.right + 12;
      setPos({
        left,
        bottom: Math.max(8, window.innerHeight - r.bottom),
        width: Math.min(width, window.innerWidth - left - 8),
      });
    }
  }, []);

  // Focus goes into the panel on open (see NotificationPanel) and comes back
  // to the bell on close, however it closed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  const patchInbox = (fn: (page: InboxPage) => InboxPage) =>
    queryClient.setQueryData<InboxPage>(INBOX_KEY, (old) => (old ? fn(old) : old));
  // A failed write says so and takes the server's page back over the guess.
  const writeFailed = () => {
    showToast(t('inbox.markReadFailed'), 'error');
    void queryClient.invalidateQueries({ queryKey: INBOX_KEY });
  };

  // Each optimistic write first cancels an inbox fetch in flight, which would
  // otherwise land after the patch with the row still unread.
  const markRead = (item: InboxItem) => {
    if (item.read_at !== null) return;
    const now = new Date().toISOString();
    void queryClient.cancelQueries({ queryKey: INBOX_KEY });
    patchInbox((page) => ({
      items: page.items.map((i) => (i.id === item.id ? { ...i, read_at: now } : i)),
      unread: Math.max(0, page.unread - 1),
    }));
    api.markInboxRead(item.id).catch(writeFailed);
  };

  const markAllRead = () => {
    const now = new Date().toISOString();
    void queryClient.cancelQueries({ queryKey: INBOX_KEY });
    patchInbox((page) => ({ items: page.items.map((i) => ({ ...i, read_at: i.read_at ?? now })), unread: 0 }));
    api.markInboxAllRead().catch(writeFailed);
  };

  const openItem = (item: InboxItem) => {
    markRead(item);
    setOpen(false);
    navigate(inboxTarget(item));
    if (item.target_id === null) showToast(t('inbox.targetGone'), 'info');
  };

  const soundOn = (prefs?.sound_kinds.length ?? 0) > 0;
  const toggleSound = () => {
    if (!prefs) return;
    const body = { kinds: prefs.kinds, sound_kinds: soundOn ? [] : prefs.kinds, auto_watch: prefs.auto_watch };
    queryClient.setQueryData<InboxPreferences>(PREFS_KEY, { ...prefs, ...body });
    api
      .putInboxPreferences(body)
      .then((saved) => queryClient.setQueryData(PREFS_KEY, saved))
      .catch(() => queryClient.invalidateQueries({ queryKey: PREFS_KEY }));
  };

  const families = [...new Set((prefs?.kinds ?? []).map(kindFamily))];
  const label = unread > 0 ? `${t('inbox.bellLabel')}, ${t('inbox.unread', { count: unread })}` : t('inbox.bellLabel');

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="notification-bell"
        onClick={() => {
          place();
          setOpen((v) => !v);
        }}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('inbox.bellLabel')}
        className={`relative p-2 rounded-lg hover:bg-bambu-dark-tertiary transition-colors ${
          open ? 'text-bambu-green' : 'text-bambu-gray-light hover:text-white'
        }`}
      >
        {ringing ? <BellRing key={arrivals} className="w-5 h-5 bell-ring" /> : <Bell className="w-5 h-5" />}
        {unread > 0 && (
          <span
            key={arrivals}
            data-testid="notification-badge"
            className="badge-pop absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-bambu-green text-[10px] font-bold leading-[1.1rem] text-bambu-dark text-center tabular-nums ring-2 ring-bambu-dark-secondary"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <NotificationPanel
          items={inbox?.items ?? []}
          unread={unread}
          families={families}
          soundOn={soundOn}
          style={pos}
          onToggleSound={toggleSound}
          onMarkAllRead={markAllRead}
          onMarkRead={markRead}
          onOpen={openItem}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
