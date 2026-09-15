import type { AitoProject } from '../../api/client';

/** Whether Finish -> Done is open for this project right now.
 *
 *  The ONE gate both surfaces that offer the transition read — the board
 *  card's Done icon (BoardColumn) and the panel footer's pill
 *  (ProjectDoneAction) — so they can never disagree about when it is
 *  available. Every clause mirrors a refusal in the server's `move_project`,
 *  and every value is the SERVER's own: the column is the derived one, the
 *  lock is the rules' own release, the contact and the invoice are facts
 *  Books and the operator wrote.
 *
 *  Its own module, like `canCreateInvoice`: the react-refresh rule refuses a
 *  module that exports both a component and a plain function.
 *
 *  - `column === 'finish'`: where the card has to be.
 *  - `move_lock === null`: keeps this off a declined quote, which sits in
 *    Done with `move_lock: 'declined'` and would 409 the move.
 *  - `client_contacted_at`: the client has to be told before the job is
 *    closed — the slot's first step (`needsClientContact`).
 *  - `quote_invoiced`, for a QUOTED project: the job is billed when the
 *    client arrives and archived once they have paid, so the invoice comes
 *    before Done — the slot's second step (`canCreateInvoice`). A card with
 *    no quote never went through Books and has nothing to invoice; gating it
 *    would hold it in Finish forever, so it passes.
 */
export function canMarkDone(
  project: Pick<AitoProject, 'column' | 'move_lock' | 'client_contacted_at' | 'quote_id' | 'quote_invoiced'>,
): boolean {
  return (
    project.column === 'finish' &&
    project.move_lock === null &&
    project.client_contacted_at !== null &&
    (!project.quote_id || project.quote_invoiced)
  );
}
