import type { ReactNode } from 'react';
import { Box, ListFilter, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import type { OrderBoardRow } from '../../api/client';
import { chipCls, FOLLOW_KEYS, followDays, PAY_CHIPS } from './orderBoard';
import type { FollowKey, PayFilter, SortKey } from './orderBoard';
import { SORTS } from './useOrderFilters';

// The Aito follow-up strip's colours: unbilled money in red, an uncollected parcel in orange.
const FOLLOW_CLS: Record<FollowKey, string> = {
  unbilled: 'border-red-400/30 bg-red-400/[0.12] text-red-400',
  notCollected: 'border-orange-400/30 bg-orange-400/[0.12] text-orange-400',
};

interface Props {
  /** `row`: the desktop controls, as direct children of the page's flex row. `sheet`: stacked groups with a footer. */
  layout: 'row' | 'sheet';
  coreOnly: boolean;
  hidden: number;
  onToggleCore: () => void;
  pay: PayFilter;
  payCounts: Record<PayFilter, number>;
  showOverdue: boolean;
  onPay: (id: PayFilter) => void;
  follow: FollowKey | null;
  followed: Record<FollowKey, OrderBoardRow[]>;
  onFollow: (key: FollowKey | null) => void;
  sort: { key: SortKey; flipped: boolean };
  onSort: (sort: { key: SortKey; flipped: boolean }) => void;
  statsOpen?: boolean;
  onToggleStats?: () => void;
  listedCount?: number;
  onClose?: () => void;
}

/** The board's filter controls: one copy for the desktop row and the phone's filter sheet. */
export function OrderMobileFilters({
  layout, coreOnly, hidden, onToggleCore, pay, payCounts, showOverdue, onPay, follow, followed, onFollow, sort, onSort,
  statsOpen, onToggleStats, listedCount, onClose,
}: Props) {
  const { t } = useTranslation();
  const sheet = layout === 'sheet';
  // A group in the sheet; the desktop row has no wrapper (its controls are the flex row's children).
  const group = (label: string, body: ReactNode) =>
    sheet ? (
      <div className="mb-3">
        <div className="mb-1.5 text-xs text-bambu-gray">{label}</div>
        {body}
      </div>
    ) : body;

  const core = (
    <button
      type="button"
      aria-pressed={coreOnly}
      onClick={onToggleCore}
      className={`btn-press inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${coreOnly ? 'border-bambu-green/50 bg-bambu-green/10 text-bambu-green' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray hover:text-white'}`}
    >
      <Box aria-hidden="true" className="h-4 w-4" />
      {t('orders.coreOnly')}
      {coreOnly && hidden > 0 && <span className="text-xs text-bambu-gray">{t('orders.hidden', { n: hidden })}</span>}
    </button>
  );

  const payRow = (
    <div className="flex flex-wrap items-center gap-1.5">
      {(['all', ...PAY_CHIPS, ...(showOverdue ? ['overdue' as const] : [])] as PayFilter[]).map(id => (
        <button key={id} type="button" aria-pressed={pay === id} onClick={() => onPay(id)} className={chipCls(pay === id)}>
          {id === 'all' ? t('orders.pay.any') : id === 'overdue' ? t('orders.pay.overdueChip') : t(`orders.pay.${id}`)}{' '}
          <span className="text-bambu-gray">{payCounts[id]}</span>
        </button>
      ))}
    </div>
  );

  const followRow = FOLLOW_KEYS.some(k => followed[k].length > 0 || follow === k) && (
    <div role="group" aria-label={t('aito.followups.title')} className="flex flex-wrap items-center gap-1.5">
      {FOLLOW_KEYS.filter(k => followed[k].length > 0 || follow === k).map(k => {
        const days = k === 'notCollected' ? followDays(followed[k]) : 0;
        return (
          <button
            key={k}
            type="button"
            aria-pressed={follow === k}
            title={t('aito.followups.hint')}
            onClick={() => onFollow(follow === k ? null : k)}
            className={`btn-press inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${FOLLOW_CLS[k]} ${follow === k ? 'ring-2 ring-current/40' : ''}`}
          >
            {follow === k ? <X aria-hidden="true" className="h-3 w-3" /> : <ListFilter aria-hidden="true" className="h-3 w-3" />}
            {t(k === 'unbilled' ? 'orders.follow.unbilled' : 'aito.followups.notCollected')}
            <span className="font-semibold tabular-nums">{followed[k].length}</span>
            {days > 0 && <span className="opacity-70">{t('aito.followups.longest', { days })}</span>}
          </button>
        );
      })}
    </div>
  );

  const sortRow = (
    <div className={`${sheet ? 'flex flex-wrap' : 'ml-auto inline-flex'} items-center gap-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-1 text-xs`}>
      {!sheet && <span className="px-2 text-bambu-gray">{t('orders.sort.label')}</span>}
      {SORTS.map(key => {
        const active = sort.key === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onSort(active ? { key, flipped: !sort.flipped } : { key, flipped: false })}
            className={`btn-press inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 ${active ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
          >
            {t(`orders.sort.${key}`)}
            {active && <span>{sort.flipped ? '↑' : '↓'}</span>}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      {group(t('orders.coreOnly'), core)}
      {group(t('orders.pay.any'), payRow)}
      {followRow && group(t('aito.followups.title'), followRow)}
      {group(t('orders.sort.label'), sortRow)}
      {sheet && onToggleStats && group(t('orders.stats.title'), (
        <button type="button" aria-pressed={statsOpen} onClick={onToggleStats} className={chipCls(!!statsOpen)}>
          {t('orders.stats.title')}
        </button>
      ))}
      {sheet && (
        <Button className="mt-1 w-full" onClick={onClose}>
          {t('orders.mobile.showOrders', { n: listedCount ?? 0 })}
        </Button>
      )}
    </>
  );
}
