import type { TFunction } from 'i18next';
import type { AitoProject } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { projectTotal, taskTotal, type TaskDraft } from '../../utils/taskDraft';

/** The card as plain text, for pasting into a message to the client or a
 *  colleague (spec A4). Three blocks, a blank line between each:
 *
 *    #41 · DEV26-2656 · Client de passage
 *    Pièce carrosserie de BMW X3
 *
 *    - Pièce carrosserie de BMW X3 — 3 750 FCFP
 *    - Boite pelicule — 31 000 FCFP
 *    Total 34 750 FCFP
 *
 *    https://…/t/<token>
 *
 *  The quote number drops out of the header when the card has none, and the
 *  last block exists only when a tracking link does. Prices are each task's
 *  total through `taskTotal`, the figure the task row and the transfer dialog
 *  show, so the pasted text never disagrees with the screen. */
export function buildSummary(
  project: AitoProject,
  tasks: TaskDraft[],
  currency: string,
  trackingUrl: string | null,
  t: TFunction,
): string {
  const header = [`#${project.id}`, project.quote_number, project.client_name ?? t('aito.noClient')]
    .filter(Boolean)
    .join(' · ');
  const headerBlock = [header, project.description.trim()].filter(Boolean).join('\n');
  const taskBlock = [
    ...tasks.map((task) => `- ${task.title.trim() || '—'} — ${formatMoney(taskTotal(task), currency)}`),
    t('aito.summaryTotal', { amount: formatMoney(projectTotal(tasks), currency) }),
  ].join('\n');
  return [headerBlock, taskBlock, trackingUrl].filter(Boolean).join('\n\n');
}

/** Write `text` to the clipboard; resolves false rather than throwing when the
 *  browser refuses. The shared helper already carries the plain-HTTP fallback
 *  (hidden textarea + `execCommand('copy')`) Fenrir needs on a LAN address. */
export { copyTextToClipboard as copyText } from '../../utils/clipboard';
