import { useId, type ElementType, type ReactNode } from 'react';

/** One section of the project page: rounded card, a header row (icon, title,
 *  optional count, optional right-hand action) and a padded body. A `region`
 *  named by its title, so tests and screen readers can find it. */
export function ProjectPanel({
  icon: Icon,
  title,
  count,
  action,
  children,
  bodyClassName = 'p-4',
  testId,
}: {
  icon: ElementType;
  title: ReactNode;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  testId?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="min-w-0 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary card-shadow"
    >
      <header className="flex min-h-[48px] flex-wrap items-center gap-2 border-b border-bambu-dark-tertiary px-4 py-2">
        <Icon className="h-4 w-4 shrink-0 text-bambu-gray" aria-hidden="true" />
        <h2 id={headingId} className="text-sm font-semibold text-white">
          {title}
        </h2>
        {count !== undefined && <span className="text-xs text-bambu-gray">{count}</span>}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
