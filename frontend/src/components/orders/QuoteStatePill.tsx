import { useTranslation } from 'react-i18next';
import type { QuoteState } from '../../api/client';
import { TONE } from './orderStatus';

// A draft wears the quotes' violet; the other states the board's usual tones.
const PILL: Record<QuoteState, { cls: string; label: string }> = {
  draft: { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', label: 'orders.quotes.state.draft' },
  sent: { cls: `${TONE.info.soft} ${TONE.info.text}`, label: 'orders.quotes.state.sent' },
  accepted: { cls: `${TONE.success.soft} ${TONE.success.text}`, label: 'orders.quotes.state.accepted' },
  expired: { cls: `${TONE.warning.soft} ${TONE.warning.text}`, label: 'orders.quotes.state.expired' },
  declined: { cls: `${TONE.danger.soft} ${TONE.danger.text}`, label: 'orders.quotes.state.declined' },
};

/** Brouillon / Envoyé / Accepté / Expiré / Refusé. */
export function QuoteStatePill({ state }: { state: QuoteState }) {
  const { t } = useTranslation();
  if (!PILL[state]) return null; // a Books status the board does not know: no pill rather than a crash
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs ${PILL[state].cls}`}>{t(PILL[state].label)}</span>;
}
