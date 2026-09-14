import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoTrackingPayment } from '../../api/client';
import { TrackCollapse } from './TrackCollapse';

/** The online payment as a STATE plus, while unpaid, the one action the
 *  client can take from here: pay. Mirrors TrackingInvoice — paid is the
 *  quiet dot-and-line, unpaid is the bordered secondary card — so the two
 *  read as the same kind of thing. The page never shows both: an invoice,
 *  when there is one, is the truer story and wins. The pay link opens in a
 *  new tab so the tracking page stays open behind OSB's checkout. */
export function TrackingPayment({ payment }: { payment: AitoTrackingPayment }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (payment.state === 'paid') {
    return (
      <div data-testid="track-payment" data-state="paid" className="text-[15px]">
        <div className="flex items-center gap-[8px]">
          <span className="h-[8px] w-[8px] shrink-0 rounded-full bg-green-500" aria-hidden="true" />
          <span className="font-semibold text-aito-ink">{t(payment.deposit ? 'aito.track.payment.depositPaidTitle' : 'aito.track.payment.paidTitle')}</span>
        </div>
        <p className="mt-[4px] text-[13px] text-aito-muted">{t('aito.track.payment.paidSub')}</p>
      </div>
    );
  }

  const button = 'inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] px-[16px] text-[13.5px] font-semibold transition-[color,background-color,transform] duration-150 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aito-cyan min-[400px]:w-auto';
  return (
    <div data-testid="track-payment" data-state="unpaid">
      <div className="flex flex-wrap items-center gap-[16px] rounded-[12px] border border-aito-line px-[16px] py-[16px] text-[15px]">
        <span className="flex min-w-0 flex-1 items-center gap-[8px]">
          <span className="h-[8px] w-[8px] shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-aito-ink">{t('aito.track.payment.unpaidTitle')}</span>
            <span className="block text-[13px] text-aito-muted">{t(payment.deposit ? 'aito.track.payment.unpaidDepositSub' : 'aito.track.payment.unpaidSub')}</span>
          </span>
        </span>
        {payment.url && (
          <a href={payment.url} target="_blank" rel="noopener noreferrer" className={`${button} bg-aito-cyan text-aito-midnight hover:brightness-110`}>
            {t('aito.track.payment.pay')}
          </a>
        )}
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={`${button} border border-aito-cyan/35 text-aito-cyan hover:bg-aito-cyan/10 active:bg-aito-cyan/15`}>
          {t('aito.track.paymentTermsToggle')}
        </button>
      </div>
      <TrackCollapse open={open}>
        <p className={`${open ? 'animate-rise' : ''} mt-[12px] px-[16px] text-[13px] text-aito-muted`}>{t('aito.track.paymentTerms')}</p>
      </TrackCollapse>
    </div>
  );
}
