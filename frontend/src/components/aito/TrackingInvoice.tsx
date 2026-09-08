import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoTrackingInvoice } from '../../api/client';

const DOT: Record<AitoTrackingInvoice, string> = { paid: 'bg-green-500', unpaid: 'bg-amber-500', overdue: 'bg-red-500' };

/** The invoice as a STATE — never an amount, never a PDF (a PDF carries
 *  the amount). Paid is quiet and borderless: a dot centred on the title
 *  only, and a sub-line, so it never competes with the state above it.
 *  Unpaid/overdue are a bordered secondary card with an outlined button
 *  that reveals the shop's payment terms, so the line is an action and
 *  not a dead end. */
export function TrackingInvoice({ state }: { state: AitoTrackingInvoice }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const copy = { title: t(`aito.track.invoice.${state}Title`), sub: t(`aito.track.invoice.${state}Sub`), terms: state !== 'paid' };

  if (state === 'paid') {
    return (
      <div data-testid="track-invoice" data-state={state} className="text-[15px]">
        <div className="flex items-center gap-[8px]">
          <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${DOT[state]}`} aria-hidden="true" />
          <span className="font-semibold text-aito-ink">{copy.title}</span>
        </div>
        <p className="mt-[4px] text-[13px] text-aito-muted">{copy.sub}</p>
      </div>
    );
  }

  return (
    <div data-testid="track-invoice" data-state={state}>
      <div className="flex flex-wrap items-center gap-[16px] rounded-[12px] border border-aito-line px-[16px] py-[16px] text-[15px]">
        <span className="flex min-w-0 flex-1 items-center gap-[8px]">
          <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${DOT[state]}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-aito-ink">{copy.title}</span>
            <span className="block text-[13px] text-aito-muted">{copy.sub}</span>
          </span>
        </span>
        {copy.terms && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-[44px] w-full shrink-0 items-center justify-center whitespace-nowrap rounded-[8px] border border-aito-cyan/35 px-[16px] text-[13.5px] font-semibold text-aito-cyan transition-[color,background-color,transform] duration-150 hover:bg-aito-cyan/10 active:scale-[0.97] active:bg-aito-cyan/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aito-cyan min-[400px]:w-auto"
          >
            {t('aito.track.paymentTermsToggle')}
          </button>
        )}
      </div>
      {copy.terms && open && <p className="animate-rise mt-[12px] px-[16px] text-[13px] text-aito-muted">{t('aito.track.paymentTerms')}</p>}
    </div>
  );
}
