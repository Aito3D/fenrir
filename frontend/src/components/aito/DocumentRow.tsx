import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { DOC_ICON_BUTTON_CLS, LINK_ICON_CLS } from './linkActionHelpers';

/** One Zoho document of the Billing card — the quote, a retainer invoice, the
 *  invoice — as one compact row: label and number on the first line, status
 *  (and amount) on the second with the document's actions pushed to its
 *  right. The same shape for all three so the card reads as one list.
 *
 *  Presentational only: the print / download / send buttons arrive already
 *  bound to their endpoint, and the Books link is a plain anchor built from
 *  `booksUrl`. Nothing here knows about queries or Zoho, which is what makes
 *  the layout testable with three bare buttons.
 *
 *  The number is plain text, not a link: the row's last icon goes to Books,
 *  and a second affordance for the same destination is what the previous
 *  layout had too many of. `numberTitle` carries the secondary facts the
 *  old definition-list rows showed (dates, mostly).
 *
 *  Icons are 24px (`DOC_ICON_BUTTON_CLS`), one step smaller than the link
 *  rows' 28px: four of them must fit beside a status line inside the rail's
 *  230px usable width (see quoteActionGroup.ts for that measurement). The
 *  cluster's `-my-1 -mr-1` pulls the buttons' own padding off the line so
 *  the glyphs align with the values above and the line does not grow. */
export function DocumentRow({
  label,
  number,
  numberTitle,
  status,
  amount,
  booksUrl,
  booksLabel,
  print,
  download,
  send,
  testId,
}: {
  label: string;
  number: string;
  numberTitle?: string;
  status?: { text: string; toneClass: string } | null;
  amount?: string | null;
  booksUrl?: string | null;
  booksLabel: string;
  print: ReactNode;
  download: ReactNode;
  send?: ReactNode;
  testId?: string;
}) {
  const lineTwo = [status?.text, amount].filter(Boolean).join(' · ');
  return (
    <div data-testid={testId} className="grid grid-cols-[auto_1fr] gap-x-3 items-baseline py-1.5 text-sm">
      <span className="text-bambu-gray">{label}</span>
      <span className="text-right min-w-0 truncate text-white" title={numberTitle}>
        {number}
      </span>
      <div className="col-span-2 flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate" title={lineTwo || undefined}>
          {status && <span className={status.toneClass}>{status.text}</span>}
          {amount && (
            <span className="text-bambu-gray">
              {status ? ' · ' : ''}
              {amount}
            </span>
          )}
        </span>
        <span className="inline-flex items-center flex-shrink-0 -my-1 -mr-1">
          {print}
          {download}
          {send}
          {booksUrl && (
            <a
              href={booksUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={booksLabel}
              title={booksLabel}
              className={DOC_ICON_BUTTON_CLS}
            >
              <ExternalLink className={LINK_ICON_CLS} aria-hidden="true" />
            </a>
          )}
        </span>
      </div>
    </div>
  );
}
