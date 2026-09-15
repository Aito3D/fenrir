/** What the client must still pay online for the quote to count as accepted —
 *  the frontend mirror of services/aito_payment_links.required_amount netted
 *  by outstanding_amount, used only for the paid-but-total-moved warning.
 *  Retainer invoices already paid in Books come off the figure (rounded up so
 *  the client is never a franc short); null once they cover it. */
export function requiredAmount(
  total: number | null,
  depositPct: number,
  retainerPaidTotal: number | null = null,
): number | null {
  if (total === null || total <= 0) return null;
  const required = depositPct <= 0 ? Math.round(total) : Math.ceil((total * depositPct) / 100);
  const outstanding = Math.ceil(required - (retainerPaidTotal ?? 0));
  return outstanding > 0 ? outstanding : null;
}
