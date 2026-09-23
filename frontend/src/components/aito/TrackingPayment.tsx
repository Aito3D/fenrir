import { useTranslation } from 'react-i18next';
import type { AitoTrackingPayment } from '../../api/client';
import { FOCUS, TERMS_BUTTON } from '../../utils/trackingShell';
import { TrackingPaidRow } from './trackingShell';

/** What a card needs to drive one of the page's side panels: whether it is
 *  open, the panel's id for `aria-controls`, and a toggle that takes the
 *  pressed button so focus can come back to it. */
export interface PanelTrigger {
  open: boolean;
  controls: string;
  toggle: (from: HTMLElement) => void;
}

/** The online payment as a STATE plus, while unpaid, the one action the
 *  client can take from here: pay. Mirrors TrackingInvoice — paid is the
 *  quiet dot-and-line, unpaid is the bordered secondary card — so the two
 *  read as the same kind of thing — and both open the page's payment panel
 *  (`terms`) from their terms button. The page never shows both: an invoice,
 *  when there is one, is the truer story and wins. The pay link opens in a
 *  new tab so the tracking page stays open behind OSB's checkout. Before the
 *  quote is accepted the card speaks in the validate voice — paying IS the
 *  client's acceptance (2026-09-22); after, the plain unpaid wording. */
export function TrackingPayment({ payment, accepted, terms }: { payment: AitoTrackingPayment; accepted: boolean; terms: PanelTrigger }) {
  const { t } = useTranslation();

  if (payment.state === 'paid') {
    return (
      <TrackingPaidRow
        data-testid="track-payment"
        data-state="paid"
        dotClassName="bg-green-500"
        title={t(payment.deposit ? 'aito.track.payment.depositPaidTitle' : 'aito.track.payment.paidTitle')}
        sub={t('aito.track.payment.paidSub')}
      />
    );
  }

  // Unpaid with no link is not a state to surface at all — nothing else on
  // this card is actionable without one (§7.3 branch 4: otherwise, nothing).
  if (!payment.url) return null;

  const button = `inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] px-[16px] text-[13.5px] font-semibold transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] ${FOCUS} min-[400px]:w-auto`;
  return (
    <div data-testid="track-payment" data-state="unpaid">
      <div className="flex flex-wrap items-center gap-[16px] rounded-[12px] border border-aito-line px-[16px] py-[16px] text-[15px]">
        <span className="flex min-w-0 flex-1 items-center gap-[8px]">
          <span className="h-[8px] w-[8px] shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-aito-ink">{t(accepted ? 'aito.track.payment.unpaidTitle' : 'aito.track.payment.validateTitle')}</span>
            <span className="block text-[13px] text-aito-muted">
              {t(
                accepted
                  ? payment.deposit ? 'aito.track.payment.unpaidDepositSub' : 'aito.track.payment.unpaidSub'
                  : payment.deposit ? 'aito.track.payment.validateDepositSub' : 'aito.track.payment.validateSub',
              )}
            </span>
          </span>
        </span>
        <a href={payment.url} target="_blank" rel="noopener noreferrer" className={`${button} bg-aito-cyan text-aito-midnight hover:brightness-110`}>
          {t('aito.track.payment.pay')}
        </a>
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
