import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import { CreateInvoiceModal } from './CreateInvoiceModal';
import { canCreateInvoice } from './canCreateInvoice';
import { focusRingCls } from '../formStyles';

/** Raise the invoice for a finished job — a footer action.
 *
 *  It sat at the foot of the Quote card until the reference cards moved
 *  behind the panel's Details tab. It is the panel's one irreversible
 *  commitment — it creates a document in the client's Books account and
 *  spends their deposits against it — and the footer is where the panel's
 *  other commitments (Mark sent, Accept, Decline, Done) already live, so it
 *  is never one tab click out of sight. Styled as their sibling: the same
 *  bordered green pill as Done, one row of buttons rather than two shapes.
 *
 *  Gated on `canUpdate` at the call site but also here, the same way
 *  `SendQuoteButton` is: POST /{project_id}/invoice enforces AITO_UPDATE.
 *  Renders itself away outside Finish — see canCreateInvoice.
 */
export function CreateInvoiceButton({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!canCreateInvoice(project)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-bambu-green/40 px-2.5 py-1 text-sm text-bambu-green transition-colors hover:bg-bambu-green/10 ${focusRingCls}`}
      >
        <FileText className="w-3.5 h-3.5" />
        {t('aito.createInvoice')}
      </button>
      {open && <CreateInvoiceModal projectId={project.id} onClose={() => setOpen(false)} />}
    </>
  );
}
