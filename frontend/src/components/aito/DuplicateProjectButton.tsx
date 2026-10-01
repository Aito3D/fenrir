import { useTranslation } from 'react-i18next';
import { CopyPlus, Loader2 } from 'lucide-react';
import { ConfirmModal } from '../ConfirmModal';
import { useDuplicateProject } from '../../hooks/useDuplicateProject';
import type { AitoProject } from '../../api/client';
import { focusRingCls } from '../formStyles';

/** The "replace the draft in progress?" question `useDuplicateProject` asks
 *  before overwriting work the operator left in the new-project drawer. */
export function DuplicateReplaceConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <ConfirmModal
      title={t('aito.duplicateReplaceTitle')}
      message={t('aito.duplicateReplaceBody')}
      confirmText={t('aito.duplicateReplaceConfirm')}
      variant="warning"
      // Asked over the detail panel, which closes on Escape too.
      isolateEscape
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/** `useDuplicateProject` as a standalone button (see that hook for what a
 *  duplicate is). The open card reaches the same gesture through its ⋯ menu. */
export function DuplicateProjectButton({
  project,
  onDuplicate,
}: {
  project: AitoProject;
  /** Fired once the seed is in storage. The page closes this panel and opens
   *  the drawer, which then reads the seed on mount. */
  onDuplicate: () => void;
}) {
  const { t } = useTranslation();
  const { start, waiting, confirming, confirmReplace, cancelReplace } = useDuplicateProject(project, onDuplicate);

  return (
    <>
      <button
        type="button"
        onClick={start}
        disabled={waiting}
        aria-label={t('aito.duplicateProject')}
        title={t('aito.duplicateProject')}
        className={`inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-bambu-gray transition-colors hover:text-white disabled:opacity-50 ${focusRingCls}`}
      >
        {waiting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CopyPlus className="h-3.5 w-3.5" />}
        {t('aito.duplicateProject')}
      </button>
      {confirming && <DuplicateReplaceConfirm onConfirm={confirmReplace} onCancel={cancelReplace} />}
    </>
  );
}
