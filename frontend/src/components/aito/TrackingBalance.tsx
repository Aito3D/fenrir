import { useTranslation } from 'react-i18next';
import type { AitoTrackingBalance } from '../../api/client';
import { formatMoney } from '../../utils/pricing';

/** The amounts under an unpaid payment or invoice card (2026-10-13) — a bar
 *  for the share already paid, then what was paid, what is left to pay (the
 *  figure that matters, in bold) and the project total. Nothing paid yet:
 *  no bar and no paid line, and the one figure reads as the amount to pay —
 *  or, for a deposit link, the deposit to pay against the total. */
export function TrackingBalance({ balance, depositDue = false }: { balance: AitoTrackingBalance; depositDue?: boolean }) {
  const { t } = useTranslation();
  const money = (n: number) => formatMoney(n, balance.currency);
  const partly = balance.paid > 0 && balance.due > 0;
  return (
    <div data-testid="track-balance" className="w-full basis-full">
      {partly && (
        <div
          className="h-[6px] w-full overflow-hidden rounded-full bg-aito-line"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={balance.paid_pct}
          aria-label={t('aito.track.balance.paidShare', { pct: balance.paid_pct })}
        >
          <div className="h-full rounded-full bg-aito-cyan" style={{ width: `${balance.paid_pct}%` }} />
        </div>
      )}
      <dl className="mt-[10px] grid grid-cols-[1fr_auto] gap-x-[16px] gap-y-[4px] text-[13.5px]">
        {partly && (
          <>
            <dt className="text-aito-muted">{t('aito.track.balance.paid', { pct: balance.paid_pct })}</dt>
            <dd className="text-right tabular-nums text-aito-muted">{money(balance.paid)}</dd>
          </>
        )}
        <dt className="font-semibold text-aito-ink">
          {t(partly ? 'aito.track.balance.due' : depositDue ? 'aito.track.balance.depositDue' : 'aito.track.balance.toPay')}
        </dt>
        <dd className="text-right font-semibold tabular-nums text-aito-ink">{money(balance.due)}</dd>
        {(partly || depositDue) && (
          <>
            <dt className="text-aito-muted">{t('aito.track.balance.total')}</dt>
            <dd className="text-right tabular-nums text-aito-muted">{money(balance.total)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
