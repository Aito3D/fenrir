import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FileText, Loader2, Search, SearchX } from 'lucide-react';
import { Button } from '../Button';
import { Skeleton } from '../Skeleton';
import { QuoteCard } from './QuoteCard';
import { chipOf, filterQuotes, quotesQuery } from './quotes';
import type { QuoteChip } from './quotes';
import type { QuoteRow } from '../../api/client';

const CHIPS: QuoteChip[] = ['current', 'expired', 'declined'];
const CHIP_LABEL: Record<QuoteChip, string> = {
  current: 'orders.quotes.chip.current',
  expired: 'orders.quotes.chip.expired',
  declined: 'orders.quotes.chip.declined',
};
const EMPTY: Record<QuoteChip, string> = {
  current: 'orders.quotes.empty.current',
  expired: 'orders.quotes.empty.expired',
  declined: 'orders.quotes.empty.declined',
};
const chipCls = (on: boolean) =>
  `btn-press shrink-0 rounded-full border px-3 py-1.5 text-xs ${on ? 'border-violet-500 bg-violet-500/15 text-white' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray hover:text-white'}`;

/** The Devis side of the Order Board: one search, three chips (current, expired, declined), the quotes.
 *  `openId` is the opened quote (the page keeps it in the URL); a quote opened from a link brings its chip up,
 *  and so does one whose chip changed (an expired quote re-dated by an edit). `onEdit` opens the quote dialog. */
export function QuotesView({ coreOnly, openId, onToggle, onEdit }: {
  coreOnly: boolean; openId: string | null; onToggle: (id: string) => void; onEdit?: (row: QuoteRow) => void;
}) {
  const { t } = useTranslation();
  const { data, isError, refetch } = useQuery(quotesQuery);
  const [chip, setChip] = useState<QuoteChip>('current');
  const [text, setText] = useState('');
  const rows = data?.ready ? data.rows : [];
  const open = openId ? rows.find(r => r.id === openId) : undefined;
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!open || followed.current === `${open.id}:${chipOf(open)}`) return;
    followed.current = `${open.id}:${chipOf(open)}`;
    setChip(chipOf(open));
  }, [open]);
  const counts = Object.fromEntries(CHIPS.map(c => [c, filterQuotes(rows, { chip: c, text, coreOnly }).length])) as Record<QuoteChip, number>;
  const listed = filterQuotes(rows, { chip, text, coreOnly });
  // The opened quote stays on screen even when "3D only" or the search would hide it.
  if (open && chipOf(open) === chip && !listed.includes(open)) listed.unshift(open);

  let list;
  if (isError && !data) {
    list = (
      <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-6 py-10 text-center">
        <div className="font-medium text-white">{t('orders.quotes.loadFailed')}</div>
        <Button variant="secondary" size="sm" className="mt-4" onClick={() => refetch()}>
          {t('orders.retry')}
        </Button>
      </div>
    );
  } else if (!data?.ready) {
    list = Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />);
  } else if (listed.length === 0) {
    const Icon = text.trim() ? SearchX : FileText;
    list = (
      <div className="rounded-xl border border-dashed border-violet-500/30 px-6 py-12 text-center">
        <Icon aria-hidden="true" className="mx-auto h-8 w-8 text-bambu-gray" />
        <div className="mt-3 font-medium text-white">{t(text.trim() ? 'orders.empty.noResults' : EMPTY[chip])}</div>
      </div>
    );
  } else {
    list = listed.map(r => <QuoteCard key={r.id} row={r} open={r.id === openId} onToggle={() => onToggle(r.id)} onEdit={onEdit && (() => onEdit(r))} />);
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative max-w-md grow basis-64">
          <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray/50" />
          <input
            type="search"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={t('orders.quotes.search')}
            aria-label={t('orders.quotes.search')}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary py-2 pl-10 pr-3 text-sm text-white placeholder:text-bambu-gray/50 focus:border-violet-500 focus:outline-none"
          />
        </div>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:px-0 md:pb-0">
          {CHIPS.map(c => (
            <button key={c} type="button" aria-pressed={chip === c} onClick={() => setChip(c)} className={chipCls(chip === c)}>
              {t(CHIP_LABEL[c])} <span className="text-bambu-gray">{data?.ready ? counts[c] : '–'}</span>
            </button>
          ))}
        </div>
      </div>
      {!!data?.loading && (
        <div role="status" className="mb-3 flex items-center gap-2 text-sm text-bambu-gray">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          {t('orders.quotes.loading', { n: data.loading })}
        </div>
      )}
      <div data-testid="quotes-list" className="space-y-2">{list}</div>
    </div>
  );
}
