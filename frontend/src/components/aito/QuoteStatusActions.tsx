import { useTranslation } from 'react-i18next';
import { Send, ThumbsDown, ThumbsUp } from 'lucide-react';
import { HoldButton } from './HoldButton';
import { useQuoteStatusMutation } from '../../hooks/useQuoteStatusMutation';
import { type AitoProject } from '../../api/client';

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

  // After every hook, so the hook order is identical on the render where the
  // quote settles and the block goes away.
  if (project.quote_status === 'accepted') return null;

  // Mark-as-sent only while the client does not have the quote yet. On sent,
  // viewed, expired and declined they already do, so offering to mark it sent
  // says nothing true.
  const canMarkSent = project.quote_status === null || project.quote_status === 'draft';
  // The exact complement of canMarkSent, and deliberately expressed as its
  // negation rather than re-derived: a quote the client has never received
  // cannot be accepted or declined. Because aito_board_rules.evaluate derives
  // the column FROM the status, this is identical to "the card is not in the
  // Quote column" — the two can never disagree, which is why the rule is
  // written against the status the server already sends rather than against
  // project.column.
  const canSettle = !canMarkSent;
  // Declining an already-declined quote is a no-op the board would still
  // hold-to-confirm and toast about. Accept is what a declined card needs.
  const canDecline = project.quote_status !== 'declined';

  return (
    <div className={layout === 'row' ? 'flex items-center gap-2' : 'flex flex-col gap-2 border-t border-bambu-dark-tertiary pt-4'}>
      {canMarkSent && (
        <HoldButton
          onHold={() => mutation.mutate('sent')}
          durationMs={500}
          disabled={mutation.isPending}
          label={t('aito.markSent')}
          hint={t('aito.holdToConfirm')}
          progress="bar"
          barClassName="bg-amber-400/25"
          className="justify-center border px-2.5 py-1 border-amber-400/40 text-amber-400 hover:bg-amber-400/10"
        >
          <Send className="w-3.5 h-3.5" />
          <span className="text-sm">{t('aito.markSent')}</span>
        </HoldButton>
      )}
      {canSettle && (
        <div className={layout === 'row' ? 'contents' : 'flex items-center gap-2'}>
          <HoldButton
            onHold={() => mutation.mutate('accepted')}
            durationMs={500}
            disabled={mutation.isPending}
            label={t('aito.acceptQuote')}
            hint={t('aito.holdToConfirm')}
            progress="bar"
            barClassName="bg-bambu-green/25"
            className="justify-center border px-2.5 py-1 border-bambu-green/40 text-bambu-green hover:bg-bambu-green/10"
          >
            <ThumbsUp className="w-3.5 h-3.5" />
            <span className="text-sm">{t('aito.acceptQuote')}</span>
          </HoldButton>
          {canDecline && (
            <HoldButton
              onHold={() => mutation.mutate('declined')}
              durationMs={500}
              disabled={mutation.isPending}
              label={t('aito.declineQuote')}
              hint={t('aito.holdToConfirm')}
              progress="bar"
              barClassName="bg-status-error/25"
              className="justify-center border px-2.5 py-1 border-status-error/40 text-status-error hover:bg-status-error/10"
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
