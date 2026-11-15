import { useTranslation } from 'react-i18next';

import type { FilamentTreeSyncPreview } from '../../api/client';
import { Button } from '../Button';
import { Dialog } from './Dialog';

/** What a SYNC is about to do, shown before anything is sent: the operator confirms or closes. */
export function SyncPreviewModal({ preview, onConfirm, onClose }: {
  preview: FilamentTreeSyncPreview;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { pull, push, conflicts } = preview;
  return (
    <Dialog
      title={t('filamentTrees.syncPreviewTitle')}
      onClose={onClose}
      footer={<Button onClick={onConfirm}>{t('common.confirm')}</Button>}
    >
      {pull.length + push.length + conflicts === 0 && (
        <p className="text-sm text-bambu-gray">{t('filamentTrees.syncPreviewNothing')}</p>
      )}
      {pull.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-semibold text-white">{t('filamentTrees.syncPreviewPull', { n: pull.length })}</h4>
          <ul className="space-y-1 text-sm">
            {pull.map((p) => (
              <li key={p.name}>
                <span className="text-white">{p.name}</span>{' '}
                <span className="break-all font-mono text-xs text-bambu-gray">{p.keys.join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {push.length > 0 && (
        <section className="space-y-2">
          <h4 className="font-semibold text-white">{t('filamentTrees.syncPreviewPush', { n: push.length })}</h4>
          <ul className="space-y-1 text-sm text-white">
            {push.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </section>
      )}
      {conflicts > 0 && <p className="text-sm text-amber-400">{t('filamentTrees.syncPreviewConflicts', { n: conflicts })}</p>}
    </Dialog>
  );
}
