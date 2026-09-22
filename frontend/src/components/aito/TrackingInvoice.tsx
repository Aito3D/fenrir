import { useTranslation } from 'react-i18next';
import type { AitoTrackingInvoice } from '../../api/client';
import type { PanelTrigger } from './TrackingPayment';
import { FOCUS } from '../../utils/trackingShell';
import { TrackingPaidRow } from './trackingShell';

const DOT: Record<AitoTrackingInvoice, string> = { paid: 'bg-green-500', unpaid: 'bg-amber-500', overdue: 'bg-red-500' };

/** The invoice as a STATE — never an amount, never a PDF (a PDF carries
 *  the amount). Paid is quiet and borderless: a dot centred on the title
 *  only, and a sub-line, so it never competes with the state above it.
 *  Unpaid/overdue are a bordered secondary card with an outlined button
 *  that opens the page's payment panel (`terms`), so the line is an action
 *  and not a dead end. */
export function TrackingInvoice({ state, terms }: { state: AitoTrackingInvoice; terms: PanelTrigger }) {
  const { t } = useTranslation();
  const title = t(`aito.track.invoice.${state}Title`);
  const sub = t(`aito.track.invoice.${state}Sub`);

  if (state === 'paid') {
    return <TrackingPaidRow data-testid="track-invoice" data-state={state} dotClassName={DOT[state]} title={title} sub={sub} />;
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
          className={`inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border px-[16px] text-[13.5px] font-semibold text-aito-cyan transition-[color,background-color,border-color,transform] duration-150 hover:bg-aito-cyan/10 active:scale-[0.97] active:bg-aito-cyan/15 ${FOCUS} min-[400px]:w-auto ${terms.open ? 'border-aito-cyan/60 bg-aito-cyan/12' : 'border-aito-cyan/35'}`}
        >
          {t('aito.track.paymentTermsToggle')}
        </button>
      </div>
    </div>
  );
}
