import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareText } from 'lucide-react';
import { type AitoProject } from '../../api/client';
import { headerPillRadiusCls } from './panelTypography';
import { SmsPickupModal } from './SmsPickupModal';

/** Open the pickup-SMS modal, from the panel header's fact row.
 *
 *  Offered only while the contact is still OWED — Finish column, contacted
 *  not yet set (the caller gates on both) — because this is the tool for
 *  paying that debt; once ContactedControl shows green the debt is paid and
 *  the slot goes back to being one pill of facts.
 *
 *  A plain click where its neighbour holds: opening a modal is free to undo,
 *  and nothing is sent until the modal's own Send. Violet rather than the
 *  contact pair's cyan/green, so the row cannot read as showing the same
 *  state twice.
 *
 *  Disabled — not hidden — without a phone number: hiding it would make "why
 *  is there no SMS button on this card" a support question, while a disabled
 *  pill with its hint in the title says exactly what is missing. */
export function SmsPickupButton({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasPhone = (project.client_phone ?? '').trim() !== '';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!hasPhone}
        aria-label={t('aito.smsPickup')}
        title={t(hasPhone ? 'aito.smsPickup' : 'aito.smsNoPhone')}
        // Same pill anatomy as ContactedControl beside it — padding, border
        // width and colour in full — so the row stays one line of pills.
        className={`${headerPillRadiusCls} inline-flex items-center gap-1 whitespace-nowrap border px-2 py-0.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 ${
          hasPhone
            ? 'border-violet-400/30 bg-violet-400/[0.14] text-violet-400 hover:bg-violet-400/25 focus-visible:ring-violet-400/40'
            : 'border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray cursor-not-allowed'
        }`}
      >
        <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
        {t('aito.smsPickupShort')}
      </button>
      {open && <SmsPickupModal project={project} onClose={() => setOpen(false)} />}
    </>
  );
}
