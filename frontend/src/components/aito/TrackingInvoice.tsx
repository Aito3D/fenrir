import { useState } from 'react';
import type { AitoTrackingInvoice } from '../../api/client';
import { FR } from '../../utils/aitoTracking';

const DOT: Record<AitoTrackingInvoice, string> = { paid: 'bg-green-500', unpaid: 'bg-amber-500', overdue: 'bg-red-500' };

/** The invoice as a STATE — never an amount, never a PDF (a PDF carries
 *  the amount). A bordered secondary card: status dot, title, sub-line,
 *  and for an unpaid invoice an outlined button that reveals the shop's
 *  payment terms, so the line is an action and not a dead end. */
export function TrackingInvoice({ state }: { state: AitoTrackingInvoice }) {
  const [open, setOpen] = useState(false);
  const copy = FR.invoice[state];
  return (
    <div data-testid="track-invoice" data-state={state}>
      <div className="flex items-center gap-3.5 rounded-xl border border-aito-line px-4 py-4 text-[15px]">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[state]}`} aria-hidden="true" />
        <span className="flex-1">
          <span className="block font-semibold text-aito-ink">{copy.title}</span>
          <span className="block text-[13px] text-aito-muted">{copy.sub}</span>
        </span>
        {copy.terms && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 whitespace-nowrap rounded-lg border border-aito-cyan/35 px-3 py-1.5 text-[13.5px] font-semibold text-aito-cyan hover:bg-aito-cyan/10"
          >
            {FR.paymentTermsToggle}
          </button>
        )}
      </div>
      {copy.terms && open && <p className="mt-3 px-4 text-sm text-aito-muted">{FR.paymentTerms}</p>}
    </div>
  );
}
