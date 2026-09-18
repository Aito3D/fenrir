import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, ThumbsDown, ThumbsUp } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { useQuoteStatusMutation } from '../../hooks/useQuoteStatusMutation';
import { useHoldSettle } from '../../hooks/useHoldSettle';
import { type AitoProject } from '../../api/client';

type QuoteStatus = AitoProject['quote_status'];

/** Which of the three actions a given status offers — the rules in the
 *  component doc below, as one lookup so the settle can compare the held-on
 *  status against the real one to know which buttons are leaving. */
function offers(status: QuoteStatus) {
  if (status === 'accepted') return { markSent: false, settle: false, decline: false };
  // Mark-as-sent only while the client does not have the quote yet. On sent,
  // viewed, expired and declined they already do, so offering to mark it sent
  // says nothing true.
  const markSent = status === null || status === 'draft';
  // The exact complement of markSent, and deliberately expressed as its
  // negation rather than re-derived: a quote the client has never received
  // cannot be accepted or declined. Because aito_board_rules.evaluate derives
  // the column FROM the status, this is identical to "the card is not in the
  // Quote column" — the two can never disagree, which is why the rule is
  // written against the status the server already sends rather than against
  // project.column.
  const settle = !markSent;
  // Declining an already-declined quote is a no-op the board would still
  // hold-to-confirm and toast about. Accept is what a declined card needs.
  const decline = settle && status !== 'declined';
  return { markSent, settle, decline };
}

/** Move this project's quote to sent, accepted or declined.
 *
 *  Each one moves the card: sent parks it in Waiting, acceptance releases it
 *  onto the work columns, a decline sends it to Done. So all three are
 *  hold-to-confirm, like delete. 500 ms rather than delete's 1000: a decline is
 *  reversible from right here (accepting a declined quote reopens it), so the
 *  gesture only has to prove intent, not discourage.
 *
 *  What renders, by quote_status — one action set per board column:
 *
 *    null, draft            Mark sent          (column: devis)
 *    sent, viewed, expired  Accept · Decline   (column: waiting)
 *    declined               Accept only        (column: done)
 *    accepted               nothing
 *
 *  ACCEPT AND DECLINE ARE HIDDEN ON null/draft. A quote the client has never
 *  received cannot be accepted or declined, so the Quote column offers only
 *  the one transition that is real. This costs the in-person acceptance case
 *  a second hold — mark sent, then accept — which was raised and accepted as
 *  the price of the columns and the actions agreeing.
 *
 *  ACCEPTED is the one terminal state: it authorises the work, the whole board
 *  is gated on it, and there is no action left to offer.
 *
 *  DECLINED deliberately keeps Accept. It is not a state the user can only
 *  reach on purpose — trashing a project declines its estimate, and
 *  re-importing that quote produces a card born declined — and there is no
 *  route out of it anywhere else: the reconciler treats a local decline as OUR
 *  decision, so it either pushes it back over a Books-side reopen or records a
 *  permanent conflict asking the user to fix it in Books, which is precisely
 *  what they would just have done. Accept here is the exit. Decline itself is
 *  hidden — the quote already is declined — and Mark as sent stays hidden for
 *  the same reason it is on `sent`: the client has the quote.
 *
 *  Mark-as-sent renders only while the client does not yet have the quote
 *  (null or draft). This REPLACES an earlier rule that kept every action
 *  visible-but-disabled with a check mark, and kept mark-as-sent live on
 *  viewed/expired for re-sending: an action already taken is now simply not
 *  offered, and nothing in this block is ever disabled-by-status. */
export function QuoteStatusActions({
  project,
  /** `column` stacks the actions with a rule above them, for the left rail
   *  they used to live in. `row` lays them out inline with no rule and no
   *  stretching, for the panel footer — where they sit at the far right,
   *  opposite the destructive action. */
  layout = 'column',
}: {
  project: AitoProject;
  layout?: 'column' | 'row';
}) {
  const { t } = useTranslation();
  const mutation = useQuoteStatusMutation(project);
  // The mutation is optimistic, so `quote_status` flips on the tick the hold
  // fires. See useHoldSettle for why the block keeps drawing from the status
  // it was held ON for a beat: rendering straight from the new one unmounted
  // the button on that frame, before its own completion bounce had started.
  const [stage, startSettle] = useHoldSettle();
  const [heldFrom, setHeldFrom] = useState<QuoteStatus>(null);
  const held = stage ? { from: heldFrom, stage } : null;
  const hold = (status: 'sent' | 'accepted' | 'declined') => {
    setHeldFrom(project.quote_status);
    startSettle();
    mutation.mutate(status);
  };

  // What the block DRAWS: the held-on status through the settle, the real
  // one otherwise. Every button is inert while a hold settles — the
  // mutation's own `isPending` covers the request, this covers the beat
  // after it lands.
  const shown = offers(held ? held.from : project.quote_status);
  const real = offers(project.quote_status);
  const disabled = mutation.isPending || held !== null;
  // A button that the held-on status offers and the real one does not is on
  // its way out; it takes the exit fade for the leaving stage.
  const leaving = (key: keyof ReturnType<typeof offers>) =>
    held?.stage === 'leaving' && shown[key] && !real[key] ? ' animate-fade-out-sm' : '';

  // After every hook, so the hook order is identical on the render where the
  // quote settles and the block goes away.
  if (!shown.markSent && !shown.settle) return null;

  return (
    <div className={layout === 'row' ? 'flex items-center gap-2' : 'flex flex-col gap-2 border-t border-bambu-dark-tertiary pt-4'}>
      {shown.markSent && (
        <HoldButton
          onHold={() => hold('sent')}
          durationMs={500}
          disabled={disabled}
          label={t('aito.markSent')}
          hint={t('aito.holdToConfirm')}
          progress="bar"
          barClassName="bg-amber-400/25"
          className={`justify-center border px-2.5 py-1 border-amber-400/40 text-amber-400 hover:bg-amber-400/10${leaving('markSent')}`}
        >
          <Send className="w-3.5 h-3.5" />
          <span className="text-sm">{t('aito.markSent')}</span>
        </HoldButton>
      )}
      {shown.settle && (
        <div className={layout === 'row' ? 'contents' : 'flex items-center gap-2'}>
          <HoldButton
            onHold={() => hold('accepted')}
            durationMs={500}
            disabled={disabled}
            label={t('aito.acceptQuote')}
            hint={t('aito.holdToConfirm')}
            progress="bar"
            barClassName="bg-bambu-green/25"
            className={`justify-center border px-2.5 py-1 border-bambu-green/40 text-bambu-green hover:bg-bambu-green/10${leaving('settle')}`}
          >
            <ThumbsUp className="w-3.5 h-3.5" />
            <span className="text-sm">{t('aito.acceptQuote')}</span>
          </HoldButton>
          {shown.decline && (
            <HoldButton
              onHold={() => hold('declined')}
              durationMs={500}
              disabled={disabled}
              label={t('aito.declineQuote')}
              hint={t('aito.holdToConfirm')}
              progress="bar"
              barClassName="bg-status-error/25"
              className={`justify-center border px-2.5 py-1 border-status-error/40 text-status-error hover:bg-status-error/10${leaving('decline')}`}
            >
              <ThumbsDown className="w-3.5 h-3.5" />
              <span className="text-sm">{t('aito.declineQuote')}</span>
            </HoldButton>
          )}
        </div>
      )}
    </div>
  );
}
