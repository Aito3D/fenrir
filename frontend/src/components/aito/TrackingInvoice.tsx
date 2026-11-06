import { useTranslation } from 'react-i18next';
import type { AitoTrackingBalance, AitoTrackingInvoice } from '../../api/client';
import type { PanelTrigger } from './TrackingPayment';
import { TrackingPaidRow, TrackingUnpaidCard } from './trackingShell';
import { TrackingBalance } from './TrackingBalance';

const DOT: Record<AitoTrackingInvoice, string> = { paid: 'bg-green-500', unpaid: 'bg-amber-500', overdue: 'bg-red-500' };

/** The invoice as a STATE — never a PDF. Paid is quiet and borderless: a
 *  dot centred on the title only, and a sub-line, so it never competes with
 *  the state above it. Unpaid or overdue with a `balance`: the amounts sit
 *  under the title, and once part is paid the sub-line names the deposit
 *  share already settled (2026-10-13).
 *  Unpaid/overdue are a bordered secondary card with an outlined button
 *  that opens the page's payment panel (`terms`), so the line is an action
 *  and not a dead end. `flipped`: this state arrived by a refetch while the
 *  page was open — the paid row pops its dot (the page rises the block). */
export function TrackingInvoice({
  state,
  terms,
  flipped = false,
  balance = null,
}: {
  state: AitoTrackingInvoice;
  balance?: AitoTrackingBalance | null;
  terms: PanelTrigger;
  flipped?: boolean;
}) {
  const { t } = useTranslation();
  const title = t(`aito.track.invoice.${state}Title`);
  const partly = state !== 'paid' && !!balance && balance.paid > 0 && balance.due > 0;
  const sub = partly
    ? t(`aito.track.invoice.${state}PartlySub`, { pct: balance!.paid_pct })
    : t(`aito.track.invoice.${state}Sub`);

  if (state === 'paid') {
    return <TrackingPaidRow data-testid="track-invoice" data-state={state} dotClassName={DOT[state]} title={title} sub={sub} pop={flipped} />;
  }

  return (
    <TrackingUnpaidCard
      data-testid="track-invoice"
      data-state={state}
      dotClassName={DOT[state]}
      title={title}
      sub={sub}
      balance={balance && <TrackingBalance balance={balance} />}
      terms={terms}
    />
  );
}
