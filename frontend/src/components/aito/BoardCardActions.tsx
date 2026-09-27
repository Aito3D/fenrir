import { useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Phone, Plane, Send, ThumbsUp } from 'lucide-react';
import { CreateInvoiceButton } from './CreateInvoiceButton';
import { HoldButton } from './HoldButton';
import { canMarkDone } from './canMarkDone';
import type { AitoProject } from '../../api/client';
import { useColumnMoveMutation } from '../../hooks/useColumnMoveMutation';
import { useContactedMutation } from '../../hooks/useContactedMutation';
import { useQuoteStatusMutation } from '../../hooks/useQuoteStatusMutation';
import { useHoldSettle } from '../../hooks/useHoldSettle';
import { isPlaceholder } from '../../utils/aitoOptimistic';
import { needsClientContact } from '../../utils/aitoBoard';

/** The board card's footer controls — the column's one-tap transitions.
 *
 *  Extracted from BoardColumn's SortableCard so the mobile board (no dnd-kit)
 *  renders the exact same buttons and gates: one implementation, two
 *  surfaces. `cardRef` is the card's own node, read at hold time as the Done
 *  celebration's origin. */
export function BoardCardActions({
  project,
  cardRef,
}: {
  project: AitoProject;
  cardRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const placeholder = isPlaceholder(project);

  // Owned here rather than threaded down from AitoPage: the hook is
  // per-project, and this component is already the one-per-project layer.
  // Hoisting it to the board would mean either one mutation per column (wrong
  // project) or a lookup by id (a second source of truth for which project a
  // card is). One hook for both quote buttons below — mark-sent and accept
  // are the same transition endpoint fed a different status.
  const quoteStatus = useQuoteStatusMutation(project);

  // Finish's counterpart to the Quote column's mark-sent: the board's only
  // other manual transition, and the only way to reach Done now that the
  // column itself is off the board. The getter is read at click time, before
  // the optimistic move takes the card off the board.
  const markDone = useColumnMoveMutation(project, 'done', () => cardRef.current?.getBoundingClientRect() ?? null);
  // The step BEFORE markDone, in the same slot. Unconditional, like every
  // hook here: the card re-renders with the contact recorded the instant the
  // optimistic write lands, and a gate above this line would change the hook
  // order on that exact render.
  const markContacted = useContactedMutation(project);

  // Which of the footer slot's two steps is live. Read from the same helper
  // CardView paints from, so the button and the card's cyan alert can never
  // disagree about whether this client still needs telling.
  const awaitingContact = needsClientContact(project) && !placeholder;

  // The slot advances Phone -> FileText -> Check on the optimistic contact
  // write, and unlike mark-sent on the Quote card nothing flies here — the
  // card stays put — so the Phone button used to unmount on the frame its
  // hold completed, before its own bounce had drawn anything. See
  // useHoldSettle: the slot keeps drawing the Phone button through that
  // choreography, then fades it out, and only then hands over.
  const [contactStage, startContactSettle] = useHoldSettle();
  const contactSettling = contactStage !== null;
  // The control that takes the slot over rises in — but only when it arrives
  // by that hand-off. On the card's own first paint the card's `animate-rise`
  // already carries it. A render-time ref, opened when a settle ends and left
  // open: a later hand-off in the same slot (invoice raised -> Done) is the
  // same kind of arrival.
  const prevContactStageRef = useRef(contactStage);
  const slotArrivedRef = useRef(false);
  if (prevContactStageRef.current !== null && contactStage === null) slotArrivedRef.current = true;
  prevContactStageRef.current = contactStage;
  // `contents` until then, so the wrapper is no box at all in the footer's
  // flex row; it only becomes one to carry the rise.
  const arrivalCls = slotArrivedRef.current ? 'inline-flex animate-rise-sm' : 'contents';

  return (
    <>
      {project.column === 'devis' && (
        // The Quote column's one real action, on the card so the column
        // can be cleared without opening anything. Deliberately NOT
        // hidden behind group-hover the way delete is: delete hides
        // because a destructive action should be hard to hit by
        // accident, and this is the opposite — the primary action of the
        // column, which an invisible button cannot be. `project.column`
        // is the server's derived value (aito_board_rules.evaluate); the
        // frontend derives nothing of its own here.
        <HoldButton
          onHold={() => quoteStatus.mutate('sent')}
          durationMs={500}
          disabled={quoteStatus.isPending}
          label={t('aito.markSent')}
          hint={t('aito.holdToConfirm')}
          progress="perimeter"
          className="p-1 -m-1 text-amber-400/70 hover:text-amber-400 hover:bg-amber-400/10 focus-visible:ring-amber-400/40 data-[holding=true]:text-amber-400"
        >
          <Send className="relative w-3.5 h-3.5" />
        </HoldButton>
      )}
      {project.column === 'waiting' && (
        // Waiting's counterpart to the Quote column's mark-sent: the
        // acceptance is what releases the card onto the work columns,
        // so it belongs on the card for the same reason — the column
        // can be cleared without opening anything. Accept only:
        // declining is rarer and destructive-adjacent, and stays behind
        // the detail panel with the rest of QuoteStatusActions. Same
        // server-derived gate as devis — a card is in `waiting` exactly
        // when its status is sent/viewed/expired, so no status check is
        // re-derived here.
        <HoldButton
          onHold={() => quoteStatus.mutate('accepted')}
          durationMs={500}
          disabled={quoteStatus.isPending}
          label={t('aito.acceptQuote')}
          hint={t('aito.holdToConfirm')}
          progress="perimeter"
          className="p-1 -m-1 text-bambu-green/70 hover:text-bambu-green hover:bg-bambu-green/10 focus-visible:ring-bambu-green/40 data-[holding=true]:text-bambu-green"
        >
          <ThumbsUp className="relative w-3.5 h-3.5" />
        </HoldButton>
      )}
      {(awaitingContact || contactSettling) && project.move_lock === null && (
        // Step one of two, in the slot Done will take once it is done.
        // ONE button, not two: the project cannot be archived until the
        // client has been told (the server 409s the move), so a Done
        // button here would be a button that can only fail. Making the
        // slot advance is what turns the rule into something you can
        // see rather than something you find out by being refused.
        //
        // The same `move_lock === null` half of the gate as Done below,
        // deliberately: a declined quote sits in Done with a lock and
        // must offer neither step.
        <HoldButton
          onHold={() => {
            startContactSettle();
            markContacted.mutate(true);
          }}
          durationMs={500}
          disabled={markContacted.isPending || contactSettling}
          label={t('aito.markContacted')}
          hint={t('aito.holdToConfirm')}
          progress="perimeter"
          // Cyan, matching the card's own alert — the button and the
          // halo are one signal, and a green button here would read as
          // "finish it", which is precisely the thing that is not
          // allowed yet.
          className={`p-1 -m-1 text-cyan-400 hover:bg-cyan-400/10 focus-visible:ring-cyan-400/40 data-[holding=true]:text-cyan-300${
            contactStage === 'leaving' ? ' animate-fade-out-sm' : ''
          }`}
        >
          <Phone className="relative w-3.5 h-3.5" />
        </HoldButton>
      )}
      {project.column === 'finish' && !awaitingContact && !contactSettling && project.move_lock === null && (
        // Step two of three, in the same slot: the job is billed when
        // the client arrives, and only then archived. Renders itself
        // away once the quote is invoiced (canCreateInvoice), which is
        // exactly when canMarkDone below opens — so the slot advances
        // Phone -> FileText -> Check and never shows two steps at once.
        // A card with no quote skips this step: nothing to bill.
        <span className={arrivalCls}>
          <CreateInvoiceButton project={project} variant="icon" />
        </span>
      )}
      {canMarkDone(project) && !contactSettling && (
        // The one shared gate (canMarkDone): column, rules lock, client
        // told, and — for a quoted project — invoiced. The panel footer
        // reads the same helper, so the two surfaces offering this one
        // transition can never disagree about when it is available.
        <span className={arrivalCls}>
        <HoldButton
          onHold={() => markDone.mutate()}
          durationMs={500}
          disabled={markDone.isPending}
          label={t('aito.markProjectDone')}
          hint={t('aito.holdToConfirm')}
          progress="perimeter"
          // invoiced = the job is billed; the pulse is the board saying
          // "archive me" without forcing the move. The color class is a
          // swap, not an addition: `text-bambu-green` and
          // `text-bambu-green/70` share specificity, so appending the
          // full-color class alongside the /70 one would leave the
          // opacity variant winning in the generated CSS.
          className={`p-1 -m-1 hover:text-bambu-green hover:bg-bambu-green/10 focus-visible:ring-bambu-green/40 data-[holding=true]:text-bambu-green ${
            project.quote_invoiced ? 'animate-invoiced-pulse text-bambu-green' : 'text-bambu-green/70'
          }`}
        >
          {/* A shipped project ends at the airport, not at the counter,
              and that is the one thing the person about to archive it
              needs to know. Enlarged from the check's w-3.5: a plane at
              check size reads as a smudge rather than an aircraft. */}
          {project.shipping_island !== null ? (
            <Plane className="relative w-[1.15rem] h-[1.15rem]" />
          ) : (
            <Check className="relative w-3.5 h-3.5" />
          )}
        </HoldButton>
        </span>
      )}
    </>
  );
}
