import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, FileText, Loader2, Mail, RotateCcw, Search, SearchX } from 'lucide-react';
import { Button } from '../Button';
import { Skeleton } from '../Skeleton';
import { prefersReducedMotion } from '../../utils/motion';
import { OrderDocumentEmailModal } from './OrderDocumentEmailModal';
import { QuoteCard } from './QuoteCard';
import { chipOf, filterQuotes, quotesQuery } from './quotes';
import type { QuoteChip } from './quotes';
import { useQuoteActions, useQuoteBusy } from './useQuoteActions';
import type { ClickedQuote, QuoteAction } from './useQuoteActions';
import type { QuoteOrderResult, QuoteRow } from '../../api/client';

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
// !text-white: the light theme turns a plain text-white dark, unreadable on violet.
const PRIMARY = '!bg-violet-600 !text-white hover:!bg-violet-500 focus:!ring-violet-500';
const chipCls = (on: boolean) =>
  `btn-press shrink-0 rounded-full border px-3 py-1.5 text-xs ${on ? 'border-violet-500 bg-violet-500/15 text-white' : 'border-bambu-dark-tertiary bg-bambu-dark-secondary text-bambu-gray hover:text-white'}`;

/** The Devis side of the Order Board: one search, three chips (current, expired, declined), the quotes.
 *  `openId` is the opened quote (the page keeps it in the URL); a quote opened from a link brings its chip up,
 *  and so does one whose chip changed (an expired quote re-dated by an edit). `onEdit` opens the quote dialog;
 *  `onOrdered` receives the order an Accept or Create order made. */
export function QuotesView({ coreOnly, openId, freshId, onFlashed, onToggle, onEdit, onOrdered }: {
  coreOnly: boolean; openId: string | null; freshId?: string | null; onFlashed?: () => void;
  onToggle: (id: string) => void; onEdit?: (row: QuoteRow) => void;
  onOrdered?: (result: QuoteOrderResult, quote: ClickedQuote) => void;
}) {
  const { t } = useTranslation();
  const { data, isError, refetch } = useQuery(quotesQuery);
  const { canUpdate, act } = useQuoteActions(onOrdered);
  const busy = useQuoteBusy(openId);
  const [emailing, setEmailing] = useState<string | null>(null);
  const [chip, setChip] = useState<QuoteChip>('current');
  const [text, setText] = useState('');
  const rows = data?.ready ? data.rows : [];
  // The rows rise in once, when the quotes first show; chips and the search later swap them in place.
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    if (!data?.ready || !entering) return;
    const id = setTimeout(() => setEntering(false), 700);
    return () => clearTimeout(id);
  }, [data?.ready, entering]);
  const open = openId ? rows.find(r => r.id === openId) : undefined;
  // The loading line folds away instead of making the rows jump: held at its last count, then unmounted.
  const loading = data?.loading ?? 0;
  const [loadingShown, setLoadingShown] = useState(0);
  if (loading > 0 && loading !== loadingShown) setLoadingShown(loading);
  useEffect(() => {
    if (loading > 0 || !loadingShown) return;
    const id = setTimeout(() => setLoadingShown(0), 170); // a beat past .row-collapse's 160ms
    return () => clearTimeout(id);
  }, [loading, loadingShown]);
  const followed = useRef<string | null>(null);
  useEffect(() => {
    if (!open || followed.current === `${open.id}:${chipOf(open)}`) return;
    followed.current = `${open.id}:${chipOf(open)}`;
    setChip(chipOf(open));
  }, [open]);
  // A quote opened from a link is brought into view once its chip shows it; one opened by a click only if it slid away.
  const clicked = useRef<string | null>(null);
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!openId) scrolled.current = null;
    if (!open || scrolled.current === open.id || chipOf(open) !== chip) return;
    scrolled.current = open.id;
    document.getElementById(`quote-${open.id}`)?.scrollIntoView?.({
      block: clicked.current === open.id ? 'nearest' : 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  });
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
    const run = (r: QuoteRow, action: QuoteAction) => act.mutate({ id: r.id, action });
    const btn = (r: QuoteRow, action: QuoteAction, label: string, primary = false) => (
      <Button key={action} size="sm" variant={primary ? 'primary' : 'secondary'} disabled={busy} onClick={() => run(r, action)}
        className={primary ? `ml-auto ${PRIMARY}` : action === 'decline' ? '!text-red-600 dark:!text-red-300' : ''}>
        {action === 'accept' && <Check aria-hidden="true" className="h-4 w-4" />}
        {action === 'reopen' && <RotateCcw aria-hidden="true" className="h-4 w-4" />}
        {label}
      </Button>
    );
    // Draft, sent, expired: email, refuse, accept. Accepted: create its order (Books reuses a draft one), refuse. Declined: reopen.
    const footer = (r: QuoteRow) => r.state === 'declined' ? btn(r, 'reopen', t('orders.quotes.reopen')) : (
      <>
        {r.state !== 'accepted' && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEmailing(r.id)}>
            <Mail aria-hidden="true" className="h-4 w-4" />
            {t('orders.quotes.send')}
          </Button>
        )}
        {btn(r, 'decline', t('orders.quotes.state.declined'))}
        {r.state === 'accepted' ? btn(r, 'order', t('orders.quotes.createOrder'), true) : btn(r, 'accept', t('orders.quotes.state.accepted'), true)}
      </>
    );
    list = listed.map(r => (
      <QuoteCard
        key={r.id}
        row={r}
        open={r.id === openId}
        onToggle={() => {
          clicked.current = r.id;
          onToggle(r.id);
        }}
        onEdit={onEdit && (() => onEdit(r))}
        fresh={r.id === freshId}
        onFlashed={onFlashed}
      >
        {canUpdate && r.id === openId ? footer(r) : null}
      </QuoteCard>
    ));
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
      {loadingShown > 0 && (
        <div className="row-collapse mb-3" data-leaving={!loading || undefined}>
          <div role="status" className="flex items-center gap-2 text-sm text-bambu-gray">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            {t('orders.quotes.loading', { n: loadingShown })}
          </div>
        </div>
      )}
      <div data-testid="quotes-list" className={`space-y-2 ${data?.ready && entering ? 'orders-rows-enter stagger-children' : ''}`}>{list}</div>
      {emailing && <OrderDocumentEmailModal quoteId={emailing} onClose={() => setEmailing(null)} />}
    </div>
  );
}
