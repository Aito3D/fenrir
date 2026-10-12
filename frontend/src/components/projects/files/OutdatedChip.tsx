import { useTranslation } from 'react-i18next';
import { chipBase } from './filesUi';

/** Amber border, tint and text (the same trio as `STATUS_CHIP_CLS.wip`). Module-local: filesUi's
 *  export list is pinned by the pdm-frontend-pure probe. */
const AMBER_CHIP_CLS = 'border-amber-500/40 bg-amber-500/10 text-amber-400';

interface Props {
  /** `{ source, newer }` from `outdatedParams`. */
  params: { source: string; newer: string };
  /** RevisionBlock's class order: `whitespace-normal` after the amber classes instead of before them. */
  wrapClassLast?: boolean;
}

/** The amber OUTDATED chip: `Outdated — based on Support R1, R2 approved since`. */
export function OutdatedChip({ params, wrapClassLast = false }: Props) {
  const { t } = useTranslation();
  const cls = wrapClassLast ? `${chipBase} ${AMBER_CHIP_CLS} whitespace-normal` : `${chipBase} whitespace-normal ${AMBER_CHIP_CLS}`;
  return <span className={cls}>{t('projectsPdm.files.outdated', params)}</span>;
}
