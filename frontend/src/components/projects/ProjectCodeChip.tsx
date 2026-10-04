import { useTranslation } from 'react-i18next';

/** The project's permanent code (P-0042) — the stable thing people say out loud
 *  and type into search, so it is set in a mono face and the accent colour. */
export function ProjectCodeChip({ code, className = '' }: { code: string | null; className?: string }) {
  const { t } = useTranslation();
  if (!code) return null;
  return (
    <span
      title={t('projectsPdm.codeChipLabel', { code })}
      className={`inline-flex shrink-0 items-center rounded-md border border-bambu-green/40 bg-bambu-green/10 px-1.5 py-0.5 font-mono text-xs font-semibold text-bambu-green ${className}`}
    >
      {code}
    </span>
  );
}
