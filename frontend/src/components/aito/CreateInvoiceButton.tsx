import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import { Button } from '../Button';
import { CreateInvoiceModal } from './CreateInvoiceModal';
import { canCreateInvoice } from './canCreateInvoice';

/** Raise the invoice for a finished job — the Quote card's last action.
 *
 *  Full width and below the segmented Print/Download/Send row rather than in
 *  it, because it is not the same kind of control. Those three read a
 *  document that already exists; this one creates a document in the client's
 *  account and spends their deposits against it. Sharing their row would
 *  make the irreversible action look like the reversible ones.
 *
 *  Gated on `canUpdate` at the call site's insistence but also here, the same
 *  way `SendQuoteButton` is: POST /{project_id}/invoice enforces AITO_UPDATE.
 */
export function CreateInvoiceButton({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!canCreateInvoice(project)) return null;

  return (
    <>
      <Button onClick={() => setOpen(true)} className="w-full mt-2" size="sm">
        <FileText className="w-4 h-4 mr-2" />
        {t('aito.createInvoice')}
      </Button>
      {open && <CreateInvoiceModal projectId={project.id} onClose={() => setOpen(false)} />}
    </>
  );
}
