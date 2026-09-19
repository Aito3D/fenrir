import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** One folded analysis section: a native `<details>` whose summary carries
 *  the section name and a one-line teaser from the data, so a closed page
 *  still says what each section would show. Opening plays the page's
 *  `rise` on the body (index.css, `.aito-acc`). */
export function SectionAccordion({
  id,
  heading,
  teaser,
  children,
}: {
  id: string;
  heading: string;
  teaser: string;
  children: ReactNode;
}) {
  return (
    <details
      id={id}
      data-testid={`aito-stats-section-${id.replace('aito-stats-', '')}`}
      className="aito-acc group rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary"
    >
      <summary className="flex cursor-pointer items-center gap-3 rounded-[.6rem] px-3 py-3 select-none hover:bg-bambu-dark-tertiary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40">
        <h2 className="min-w-16 text-xs uppercase tracking-wide text-bambu-gray">{heading}</h2>
        <p className="min-w-0 flex-1 truncate text-xs text-bambu-gray-light">{teaser}</p>
        <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-bambu-gray transition-transform duration-150 ease-(--ease-signature) group-open:rotate-180 motion-reduce:transition-none" />
      </summary>
      <div className="aito-acc-body px-3 pb-3">{children}</div>
    </details>
  );
}
