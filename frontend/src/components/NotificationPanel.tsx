import { useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Volume2, VolumeX, X } from 'lucide-react';
import type { InboxItem } from '../api/client';
import { formatRelativeTime } from '../utils/date';
import { NOTIFICATION_KINDS, UNKNOWN_KIND } from './notificationKinds';

type Filter = 'all' | 'aito' | 'printer';

interface NotificationPanelProps {
  items: InboxItem[];
  unread: number;
  /** Families the user has enabled; the chips show only when there are several. */
  families: string[];
  soundOn: boolean;
  style: CSSProperties;
  onToggleSound: () => void;
  onMarkAllRead: () => void;
  onMarkRead: (item: InboxItem) => void;
  onOpen: (item: InboxItem) => void;
  onClose: () => void;
}

const FILTER_LABEL: Record<Filter, string> = {
  all: 'inbox.filterAll',
  aito: 'inbox.filterAito',
  printer: 'inbox.filterPrinters',
};

const iconButton = 'p-1.5 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors';

/** The inbox panel: fixed beside the bell, portalled so no sidebar transform or overflow clips it. */
export function NotificationPanel({
  items,
  unread,
  families,
  soundOn,
  style,
  onToggleSound,
  onMarkAllRead,
  onMarkRead,
  onOpen,
  onClose,
}: NotificationPanelProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>('all');
  const showChips = families.length > 1;
  const visible = !showChips || filter === 'all' ? items : items.filter((i) => i.family === filter);

  return createPortal(
    <div className="fixed inset-0 z-[120]">
      <div className="absolute inset-0" data-testid="notification-scrim" onClick={onClose} />
      <div
        role="dialog"
        aria-label={t('inbox.title')}
        data-testid="notification-panel"
        style={style}
        className="absolute max-h-[min(34rem,calc(100vh-4rem))] flex flex-col rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-2xl animate-pop-in"
      >
        <header className="flex items-center gap-2 px-4 pt-3 pb-2">
          <h2 className="text-sm font-semibold text-white">{t('inbox.title')}</h2>
          {unread > 0 && (
            <span className="text-xs text-bambu-gray tabular-nums">{t('inbox.unread', { count: unread })}</span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onToggleSound}
            aria-label={soundOn ? t('inbox.soundOn') : t('inbox.soundOff')}
            title={soundOn ? t('inbox.soundOn') : t('inbox.soundOff')}
            className={iconButton}
          >
            {soundOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onMarkAllRead}
            disabled={unread === 0}
            className="text-xs text-bambu-green hover:text-bambu-green/80 disabled:text-bambu-gray disabled:cursor-default px-1.5 py-1"
          >
            {t('inbox.markAllRead')}
          </button>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className={iconButton}>
            <X className="w-4 h-4" />
          </button>
        </header>
        {showChips && (
          <div className="flex gap-1 px-4 pb-2">
            {(['all', 'aito', 'printer'] as const)
              .filter((f) => f === 'all' || families.includes(f))
              .map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  aria-pressed={filter === f}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    filter === f ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'
                  }`}
                >
                  {t(FILTER_LABEL[f])}
                </button>
              ))}
          </div>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto border-t border-bambu-dark-tertiary">
          {visible.length === 0 && <li className="px-4 py-8 text-center text-sm text-bambu-gray">{t('inbox.empty')}</li>}
          {visible.map((item) => (
            <NotificationRow key={item.id} item={item} onOpen={onOpen} onMarkRead={onMarkRead} />
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  );
}

function NotificationRow({
  item,
  onOpen,
  onMarkRead,
}: {
  item: InboxItem;
  onOpen: (item: InboxItem) => void;
  onMarkRead: (item: InboxItem) => void;
}) {
  const { t } = useTranslation();
  const meta = NOTIFICATION_KINDS[item.kind];
  const Icon = (meta ?? UNKNOWN_KIND).icon;
  const read = item.read_at !== null;
  const title = meta ? t(`inbox.kind.${meta.titleKey}`) : item.title;

  return (
    <li className="relative group">
      <button
        type="button"
        data-testid={`notification-row-${item.id}`}
        onClick={() => onOpen(item)}
        className={`w-full grid grid-cols-[32px_1fr_auto] items-start gap-3 py-2.5 pl-4 pr-8 text-left transition-colors hover:bg-bambu-dark ${
          read ? '' : 'bg-bambu-green/[0.04]'
        }`}
      >
        <span className={`mt-0.5 grid h-8 w-8 place-items-center rounded-lg ${(meta ?? UNKNOWN_KIND).tone}`}>
          <Icon className="w-4 h-4" />
        </span>
        <span className="min-w-0">
          <span className={`block text-sm truncate ${read ? 'text-bambu-gray-light' : 'text-white font-medium'}`}>
            {title}
          </span>
          <span className="block text-xs text-bambu-gray truncate">{item.body}</span>
        </span>
        <span className="flex flex-col items-end gap-1 pt-0.5">
          <span className="text-[11px] text-bambu-gray tabular-nums whitespace-nowrap">
            {formatRelativeTime(item.created_at, 'system', t)}
          </span>
          <span className="flex items-center text-[11px] text-bambu-gray group-hover:text-bambu-green">
            <ChevronRight className="w-3.5 h-3.5 group-hover:hidden" />
            <span className="hidden group-hover:inline">{t('inbox.open')}</span>
          </span>
        </span>
      </button>
      {!read && (
        <button
          type="button"
          data-testid={`notification-dot-${item.id}`}
          onClick={() => onMarkRead(item)}
          aria-label={t('inbox.markRead')}
          title={t('inbox.markRead')}
          className="absolute right-2 top-3 grid h-5 w-5 place-items-center rounded-full hover:bg-bambu-dark-tertiary"
        >
          <span className="h-2 w-2 rounded-full bg-bambu-green" />
        </button>
      )}
    </li>
  );
}
