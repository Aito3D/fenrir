import type { ReactNode } from 'react';

/** One group of the left rail. `bg-bambu-dark-secondary` with a border and NO
 *  shadow: only the task cards cast one, so the column the operator works in
 *  stays the front plane. Spreading the shadow over every group is what makes
 *  the task list stop being the focus.
 *
 *  Lives in its own module rather than inside ProjectDetailPanel, where it was
 *  first written: the panel renders InvoiceCard, and InvoiceCard needs this
 *  shell, so leaving it there made the two files import each other. The cycle
 *  happened to work — both sides are hoisted function declarations touched only
 *  at render time — but it is a trap for the next card that needs a shell and
 *  reaches for it during module initialisation instead.
 */
export function PanelCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p data-testid="panel-card-heading" className="text-xs uppercase tracking-wide text-bambu-gray">
          {title}
        </p>
        {action}
      </div>
      {children}
    </section>
  );
}
