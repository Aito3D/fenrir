/** What the client must pay online for the quote to count as accepted —
 *  the frontend mirror of services/aito_payment_links.required_amount, used
 *  only for the paid-but-total-moved warning. */
export function requiredAmount(total: number | null, depositPct: number): number | null {
  if (total === null || total <= 0) return null;
  return depositPct <= 0 ? Math.round(total) : Math.ceil((total * depositPct) / 100);
}
