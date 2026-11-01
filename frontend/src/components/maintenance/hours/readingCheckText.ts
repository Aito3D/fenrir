import type { TFunction } from 'i18next';
import { dayNumber, type ReadingCheck } from '../../../utils/hoursSeries';

/** Sentences for the wrong-number check, shared by the step-by-step pass and the one-page form. */
export function readingCheckText(t: TFunction, language: string) {
  const fmt = (v: number) => Math.round(v).toLocaleString(language);
  const dayFmt = new Intl.DateTimeFormat(language, { timeZone: 'UTC' });
  const fmtDate = (d: string) => dayFmt.format(dayNumber(d) * 86_400_000);

  /** The amber sentence for a questioned reading, or null when the reading is fine. */
  const questionText = (c: ReadingCheck, typed: number): string | null => {
    if (c.level !== 'question' || !c.last) return null;
    if (c.reason === 'backwards') return t('maintenance.hours.pass.backwards', { hours: fmt(c.last.hours), date: fmtDate(c.last.date) });
    return t('maintenance.hours.pass.farFromCounter', {
      typed: fmt(typed - c.last.hours), counted: fmt(c.counterDelta ?? 0), date: fmtDate(c.last.date), expected: fmt(c.expected ?? 0),
    });
  };

  /** The result line under a typed number: amber question, or muted okDelta / noReference. */
  const resultLine = (c: ReadingCheck, typed: number): { text: string; amber: boolean } => {
    const q = questionText(c, typed);
    if (q) return { text: q, amber: true };
    if (c.reason === 'ok' && c.last && c.counterDelta !== null) {
      return { text: t('maintenance.hours.pass.okDelta', { typed: fmt(typed - c.last.hours), counted: fmt(c.counterDelta) }), amber: false };
    }
    return { text: t('maintenance.hours.pass.noReference'), amber: false };
  };

  return { fmt, fmtDate, questionText, resultLine };
}
