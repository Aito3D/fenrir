import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';

/** The project's permanent code (P-0042) — the stable thing people say out loud
 *  and type into search, so it is set in a mono face and the accent colour. */
export function ProjectCodeChip({ code, className = '' }: { code: string | null; className?: string }) {
  const { t } = useTranslation();
  if (!code) return null;
  return (
    <span
      title={t('projectsPdm.codeChipLabel', { code })}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ${className}`}
    >
      {code}
    </span>
  );
}

/** A project option's label inside a picker button: the code chip, then the
 *  name, truncated to the space left. */
export function ProjectOptionLabel({ code, name }: { code: string | null; name: string }) {
  return (
    <>
      <ProjectCodeChip code={code} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </>
  );
}

/** The picker's search box: magnifier, borderless `type="search"` input, and a
 *  trailing slot (the spinner). `className` carries the label's own padding
 *  and background, which differ per picker. */
export function ProjectSearchInput({
  value,
  onChange,
  label,
  className,
  autoFocus,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Used as both the placeholder and the accessible name. */
  label: string;
  className: string;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  return (
    <label className={className}>
      <Search aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-bambu-gray" />
      <input
        type="search"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none"
      />
      {children}
    </label>
  );
}

/** One project row in a picker list: the option label, then an optional
 *  trailing hint (children). `className` is the row's full class string. */
export function ProjectOptionButton({
  code,
  name,
  onClick,
  className,
  pressed,
  disabled,
  children,
}: {
  code: string | null;
  name: string;
  onClick: () => void;
  className: string;
  pressed?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button type="button" aria-pressed={pressed} disabled={disabled} onClick={onClick} className={className}>
      <ProjectOptionLabel code={code} name={name} />
      {children}
    </button>
  );
}
