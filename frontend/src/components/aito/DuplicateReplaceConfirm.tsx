import { useTranslation } from 'react-i18next';
import { ConfirmModal } from '../ConfirmModal';

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
