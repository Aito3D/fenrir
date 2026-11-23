import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ExternalLink, Pencil } from 'lucide-react';
import { api } from '../../api/client';
import type { QuoteLine, QuoteRow } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoney } from '../../utils/pricing';
import { Button } from '../Button';
import { Card } from '../Card';
import { Skeleton } from '../Skeleton';
import { DOC_ICON_BUTTON_CLS } from '../aito/linkActionHelpers';
import { PanelCard } from '../aito/PanelCard';
import { PdfDownloadButton } from '../aito/PdfDownloadButton';
import { PdfPrintButton } from '../aito/PdfPrintButton';
import { daysPastDue, formatQty, parseDay } from './orderBoard';
import { OrderActivity } from './OrderActivity';
import { OrderContactBlock } from './OrderContactBlock';
import { TONE } from './orderStatus';
import { QuoteStatePill } from './QuoteStatePill';

// Customer, lines, state, total, chevron. Below lg: customer and state, then lines and total.
const QUOTE_GRID =
  'grid items-center gap-x-3 gap-y-1 grid-cols-[minmax(0,1fr)_auto_1.25rem] ' +
  "[grid-template-areas:'cust_state_chev'_'lines_value_chev'] " +
  'lg:[grid-template-areas:none] lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_auto_7.5rem_1.25rem]';
const LINE_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 md:grid-cols-[minmax(0,1fr)_7rem_3.5rem_4.5rem_7.5rem] md:items-center';

/** "4× PLA Basic · +2": the first line, then how many more. */
const summary = (lines: QuoteLine[]) =>
  lines.length ? `${formatQty(lines[0].quantity)}× ${lines[0].name}${lines.length > 1 ? ` · +${lines.length - 1}` : ''}` : '';
/** A sent quote this close to its last day gets the warning tone on the row. */
const EXPIRING_DAYS = 3;

function Stock({ line }: { line: QuoteLine }) {
  const { t } = useTranslation();
  if (line.available === null) return <span />;
  const ok = line.available >= line.quantity;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-bambu-gray">
      <span aria-hidden="true" className={`h-2 w-2 rounded-full ${ok ? 'bg-green-500' : 'bg-yellow-500'}`} />
      {ok ? t('orders.quotes.inStock', { n: formatQty(line.available) }) : t('orders.quotes.toOrder')}
    </span>
  );
}

/** The opened quote's side column: the customer, the history. */
function QuoteSide({ row }: { row: QuoteRow }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const contact = useQuery({
    queryKey: ['zoho-contact', row.customer_id],
    queryFn: () => api.getZohoContact(row.customer_id),
    enabled: !!row.customer_id,
    staleTime: 60_000,
  });
  return (
    <div className="min-w-0 space-y-3 lg:self-start">
      {/* Shown once Books answered: a loading card would read "no phone, no email". */}
      {(contact.data || contact.isError) && (
        <OrderContactBlock
          contact={contact.data ?? { name: row.customer, email: '', phone: '', mobile: '' }}
          orderNumber=""
          others={[]}
          customerId={row.customer_id}
          canEdit={hasPermission('aito:create') && !!contact.data}
        />
      )}
      <PanelCard title={t('aito.history.title')}>
        <OrderActivity soId={row.id} currency={row.currency} quote />
      </PanelCard>
    </div>
  );
}

/** One quote, a thin violet edge its only colour: the collapsed row is the button that opens its lines.
 *  The toolbar sits right under the row: Edit (given `onEdit`) or, for a quote this screen cannot edit, "Edit in Zoho"
 *  (a plain link, for every viewer), the PDF and Books icons, then `children` (the state actions). */
export function QuoteCard({ row, open, onToggle, onEdit, fresh, onFlashed, children }: {
  row: QuoteRow; open: boolean; onToggle: () => void; onEdit?: () => void; fresh?: boolean; onFlashed?: () => void; children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const money = (n: number) => formatMoney(n, row.currency);
  const day = (iso: string) => parseDay(iso).toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' });
  // "10%" stays as Books wrote it; a fixed amount ("500") reads as money.
  const discount = (d: string) => (d.endsWith('%') ? d : money(Number(d)));
  const fetchPdf = () => api.getQuotePdf(row.id);
  const expiring = row.state === 'sent' && !!row.expiry_date && daysPastDue(row.expiry_date) >= -EXPIRING_DAYS;
  const edit = row.editable ? onEdit && (
    <Button variant="secondary" size="sm" onClick={onEdit}>
      <Pencil aria-hidden="true" className="h-4 w-4" />
      {t('orders.quotes.edit')}
    </Button>
  ) : row.zoho_url ? (
    <a href={row.zoho_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-violet-700 hover:underline dark:text-violet-300">
      {t('orders.quotes.editInZoho')}
      <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
    </a>
  ) : null;
  return (
    <Card id={`quote-${row.id}`} className="overflow-clip border-l-2 border-l-violet-500/60">
      {/* A created or edited quote flashes once, as a saved order's row does. */}
      <div
        data-fresh={fresh || undefined}
        onAnimationEnd={e => { if (e.target === e.currentTarget) onFlashed?.(); }}
        className={`relative ${fresh ? 'animate-row-flash flash-violet' : ''}`}
      >
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={`w-full px-4 py-3 text-left hover:bg-bambu-dark-tertiary/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-400 ${QUOTE_GRID}`}
        >
          <span className="min-w-0 [grid-area:cust] lg:[grid-area:auto]">
            <span className="block truncate text-white">{row.customer || '–'}</span>
            <span className="block truncate text-xs text-bambu-gray">
              <span className="font-mono">{row.number}</span> · {day(row.date)}
              {row.state === 'sent' && row.expiry_date && (
                <> · <span data-testid={expiring ? 'quote-expiring' : undefined} className={expiring ? TONE.warning.text : ''}>{t('orders.quotes.validUntil', { date: day(row.expiry_date) })}</span></>
              )}
            </span>
          </span>
          <span className="min-w-0 truncate text-xs text-bambu-gray [grid-area:lines] lg:[grid-area:auto]">{row.lines ? summary(row.lines) : ''}</span>
          <span className="justify-self-end [grid-area:state] lg:justify-self-start lg:[grid-area:auto]">
            <QuoteStatePill state={row.state} />
          </span>
          <span className={`text-right text-sm tabular-nums [grid-area:value] lg:[grid-area:auto] ${row.total === null ? 'text-bambu-gray' : 'text-white'}`}>
            {row.total === null ? '–' : money(row.total)}
          </span>
          <ChevronDown aria-hidden="true" className={`h-4 w-4 text-bambu-gray transition-transform [grid-area:chev] lg:[grid-area:auto] lg:justify-self-end ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div className="animate-rise-sm border-t border-bambu-dark-tertiary">
            <div data-testid="quote-actions" className="flex flex-wrap items-center gap-2 border-b border-bambu-dark-tertiary px-4 py-2">
              {edit}
              <span className="inline-flex items-center">
                <PdfPrintButton variant="icon" fetchPdf={fetchPdf} label={t('aito.printQuote')} failureMessage={t('aito.printFailed')} />
                <PdfDownloadButton variant="icon" fetchPdf={fetchPdf} label={t('aito.downloadQuote')} filename={row.number} failureMessage={t('aito.printFailed')} />
                {row.zoho_url && (
                  <a href={row.zoho_url} target="_blank" rel="noopener noreferrer" aria-label={t('aito.quoteOpenInZoho')} title={t('aito.quoteOpenInZoho')} className={DOC_ICON_BUTTON_CLS}>
                    <ExternalLink aria-hidden="true" className="h-4 w-4" />
                  </a>
                )}
              </span>
              {children}
            </div>
            <div className="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_27rem]">
              <div className="min-w-0">
                {row.lines ? (
                  <>
                    <div aria-hidden="true" className={`${LINE_GRID} pb-1.5 text-[11px] uppercase tracking-wide text-bambu-gray max-md:hidden`}>
                      <span>{t('orders.quotes.col.item')}</span>
                      <span>{t('orders.quotes.col.stock')}</span>
                      <span className="text-right">{t('orders.quotes.col.qty')}</span>
                      <span className="text-right">{t('orders.quotes.col.discount')}</span>
                      <span className="text-right">{t('aito.tax.beforeTax')}</span>
                    </div>
                    <ul aria-label={t('orders.quotes.col.item')} className="divide-y divide-bambu-dark-tertiary text-sm">
                      {row.lines.map(l => (
                        <li key={l.id} className={`${LINE_GRID} py-2`}>
                          <span className="col-span-2 min-w-0 truncate text-white md:col-span-1">
                            {l.name}
                            {l.sku && <span className="ml-2 font-mono text-xs text-bambu-gray">{l.sku}</span>}
                          </span>
                          <Stock line={l} />
                          <span className="text-right tabular-nums max-md:hidden">{formatQty(l.quantity)}</span>
                          <span className="text-right text-bambu-gray max-md:hidden">{l.discount ? discount(l.discount) : '—'}</span>
                          <span className="text-right tabular-nums text-white">
                            <span className="text-bambu-gray md:hidden">{formatQty(l.quantity)}×{l.discount ? ` −${discount(l.discount)}` : ''} · </span>
                            {money(l.total)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {/* The lines are before tax: without this the row's total matches nothing above it. */}
                    {row.total !== null && row.tax_total != null && (
                      <dl data-testid="quote-totals" className="ml-auto mt-2 grid w-full max-w-64 grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t border-bambu-dark-tertiary pt-2 text-sm tabular-nums text-bambu-gray">
                        <dt>{t('aito.tax.beforeTax')}</dt>
                        <dd className="text-right">{money(row.total - row.tax_total)}</dd>
                        <dt>{t('aito.tax.label')}</dt>
                        <dd className="text-right">{money(row.tax_total)}</dd>
                        <dt className="text-white">{t('orders.quotes.col.total')}</dt>
                        <dd className="text-right text-white">{money(row.total)}</dd>
                      </dl>
                    )}
                  </>
                ) : (
                  <div data-testid="quote-lines-loading" className="space-y-2">
                    {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-8 rounded-md" />)}
                  </div>
                )}
              </div>
              <QuoteSide row={row} />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
