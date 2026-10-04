/** The Apply-deposit modal's starting amount: whichever runs out first, the
 *  invoice balance or the deposit's unused money. On a tie the invoice wins
 *  the label — "pays in full" is the fact the operator cares about. */
export function depositPrefill(balance: number, applicable: number): { amount: number; reason: 'paysInFull' | 'usesAll' } {
  const round = (n: number) => Math.round(n * 100) / 100;
  return applicable >= balance
    ? { amount: round(balance), reason: 'paysInFull' }
    : { amount: round(applicable), reason: 'usesAll' };
}
