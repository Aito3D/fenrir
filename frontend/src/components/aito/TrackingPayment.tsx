import { useTranslation } from 'react-i18next';
import type { AitoTrackingBalance, AitoTrackingPayment } from '../../api/client';
import { FOCUS } from '../../utils/trackingShell';
import { TrackingPaidRow, TrackingUnpaidCard } from './trackingShell';
import { TrackingBalance } from './TrackingBalance';

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
 *  client's acceptance (2026-09-22); after, the plain unpaid wording.
 *  With a `balance`, the amounts sit under the title; once part of the
 *  quote is paid (a deposit by transfer or at the counter, netted off the
 *  link), the card names that share instead of "not paid" (2026-10-13).
 *  `flipped`: this state arrived by a refetch while the page was open (the
 *  page rises the card; the paid row also pops its dot). */
export function TrackingPayment({
  payment,
  accepted,
  terms,
  flipped = false,
  balance = null,
}: {
  payment: AitoTrackingPayment;
  accepted: boolean;
  balance?: AitoTrackingBalance | null;
  terms: PanelTrigger;
  flipped?: boolean;
}) {
  const { t } = useTranslation();

  if (payment.state === 'paid') {
    return (
      <TrackingPaidRow
        data-testid="track-payment"
        data-state="paid"
        dotClassName="bg-green-500"
        pop={flipped}
        title={t(payment.deposit ? 'aito.track.payment.depositPaidTitle' : 'aito.track.payment.paidTitle')}
        sub={t('aito.track.payment.paidSub')}
      />
    );
  }

  // Unpaid with no link is not a state to surface at all — nothing else on
  // this card is actionable without one (§7.3 branch 4: otherwise, nothing).
  if (!payment.url) return null;

  const partly = !!balance && balance.paid > 0 && balance.due > 0;
  const button = `inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] px-[16px] text-[13.5px] font-semibold transition-[color,background-color,border-color,transform,filter] duration-150 active:scale-[0.97] ${FOCUS} min-[400px]:w-auto`;
  return (
    <TrackingUnpaidCard
      data-testid="track-payment"
      data-state="unpaid"
      dotClassName="bg-amber-500"
      title={
        partly
          ? t('aito.track.payment.partlyPaidTitle', { pct: balance!.paid_pct })
          : t(accepted ? 'aito.track.payment.unpaidTitle' : 'aito.track.payment.validateTitle')
      }
      sub={
        partly
          ? t('aito.track.payment.partlyPaidSub')
          : t(
              accepted
                ? payment.deposit ? 'aito.track.payment.unpaidDepositSub' : 'aito.track.payment.unpaidSub'
                : payment.deposit ? 'aito.track.payment.validateDepositSub' : 'aito.track.payment.validateSub',
            )
      }
      balance={balance && <TrackingBalance balance={balance} depositDue={payment.deposit && !partly} />}
      terms={terms}
    >
      <a href={payment.url} target="_blank" rel="noopener noreferrer" className={`${button} bg-aito-cyan text-aito-midnight hover:brightness-110`}>
        {t('aito.track.payment.pay')}
      </a>
    </TrackingUnpaidCard>
  );
}
