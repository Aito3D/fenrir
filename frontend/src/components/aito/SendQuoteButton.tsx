import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ACTION_CELL } from './quoteActionGroup';
import { Mail } from 'lucide-react';
import { type AitoProject } from '../../api/client';
import { SendQuoteModal } from './SendQuoteModal';

/** Email this project's quote to the client, from the panel's Quote card.
 *
 *  Offered wherever there is a quote to send — not only in the Quote column.
 *  Re-sending a quote already out with the client (they lost the mail, you
 *  are chasing an old one) is a real thing to want; the server is what
 *  decides whether the card also moves, and it never demotes an accepted one.
 *
 *  Same gate and the same pill styling as QuotePrintButton's labelled form:
 *  the two sit side by side and must not read as two different kinds of
 *  control.
 */
export function SendQuoteButton({
  project,
}: {
  project: AitoProject;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // After the hook, so hook order is identical on the render where a quote
  // gets attached and this stops returning null.
  if (!project.quote_id) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('aito.sendQuote')}
        title={t('aito.sendQuote')}
        className={ACTION_CELL}
      >
        <Mail className="w-3.5 h-3.5" />
      </button>
      {open && <SendQuoteModal project={project} onClose={() => setOpen(false)} />}
    </>
  );
}
