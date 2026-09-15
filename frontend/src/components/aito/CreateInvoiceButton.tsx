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
 *
 *  Two shapes, one component: the panel footer's labelled pill, and the
 *  board card's icon — the middle step of the card's footer slot, between
 *  "client told" (Phone) and "archive" (Check). The card's siblings are all
 *  HoldButtons because they commit on release; this one is a plain click,
 *  because the dialog it opens is the confirmation, with the preview of
 *  exactly what will be raised and which deposits it spends. A hold in front
 *  of a confirm dialog would be two confirmations for one action.
 */
export function CreateInvoiceButton({ project, variant = 'pill' }: { project: AitoProject; variant?: 'pill' | 'icon' }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!canCreateInvoice(project)) return null;

  return (
    <>
      {variant === 'icon' ? (
        // Sized and coloured like the card's other slot buttons (BoardColumn's
        // HoldButtons): `p-1 -m-1` so the hit target grows without moving
        // the glyph, green because it is the step towards closing the job.
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t('aito.createInvoice')}
          title={t('aito.createInvoice')}
          className={`p-1 -m-1 rounded text-bambu-green/70 transition-colors hover:text-bambu-green hover:bg-bambu-green/10 ${focusRingCls} focus-visible:ring-bambu-green/40`}
        >
          <FileText className="w-3.5 h-3.5" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-bambu-green/40 px-2.5 py-1 text-sm text-bambu-green transition-colors hover:bg-bambu-green/10 ${focusRingCls}`}
        >
          <FileText className="w-3.5 h-3.5" />
          {t('aito.createInvoice')}
        </button>
      )}
      {open && <CreateInvoiceModal projectId={project.id} onClose={() => setOpen(false)} />}
    </>
  );
}
