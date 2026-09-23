import { useTranslation } from 'react-i18next';
import type { AitoTrackingInvoice } from '../../api/client';
import type { PanelTrigger } from './TrackingPayment';
import { TERMS_BUTTON } from '../../utils/trackingShell';
import { TrackingPaidRow } from './trackingShell';

const DOT: Record<AitoTrackingInvoice, string> = { paid: 'bg-green-500', unpaid: 'bg-amber-500', overdue: 'bg-red-500' };

/** The invoice as a STATE — never an amount, never a PDF (a PDF carries
 *  the amount). Paid is quiet and borderless: a dot centred on the title
 *  only, and a sub-line, so it never competes with the state above it.
 *  Unpaid/overdue are a bordered secondary card with an outlined button
 *  that opens the page's payment panel (`terms`), so the line is an action
 *  and not a dead end. `flipped`: this state arrived by a refetch while the
 *  page was open — the paid row pops its dot (the page rises the block). */
export function TrackingInvoice({
  state,
  terms,
  flipped = false,
}: {
  state: AitoTrackingInvoice;
  terms: PanelTrigger;
  flipped?: boolean;
}) {
  const { t } = useTranslation();
  const title = t(`aito.track.invoice.${state}Title`);
  const sub = t(`aito.track.invoice.${state}Sub`);

  if (state === 'paid') {
    return <TrackingPaidRow data-testid="track-invoice" data-state={state} dotClassName={DOT[state]} title={title} sub={sub} pop={flipped} />;
  }

  return (
    <div data-testid="track-invoice" data-state={state}>
      <div className="flex flex-wrap items-center gap-[16px] rounded-[12px] border border-aito-line px-[16px] py-[16px] text-[15px]">
        <span className="flex min-w-0 flex-1 items-center gap-[8px]">
          <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${DOT[state]}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-aito-ink">{title}</span>
            <span className="block text-[13px] text-aito-muted">{sub}</span>
          </span>
        </span>
        {/* Unpaid and overdue both get it: only `paid` returned above. */}
        <button
          type="button"
          aria-expanded={terms.open}
          aria-controls={terms.controls}
          onClick={(e) => terms.toggle(e.currentTarget)}
          className={`${TERMS_BUTTON} ${terms.open ? 'border-aito-cyan/60 bg-aito-cyan/12' : 'border-aito-cyan/35'}`}
        >
          {t('aito.track.paymentTermsToggle')}
        </button>
      </div>
    </div>
  );
}
