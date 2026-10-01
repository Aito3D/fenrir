import type { AitoProject } from '../../api/client';

/** Whether a project is at the point where billing it is the next thing to do.
 *
 *  Its own module, not an export off CreateInvoiceButton: that file exports a
 *  component, and the react-refresh rule (rightly) refuses to let a module
 *  export both — a constant changing would blow away the component's state on
 *  every hot reload.
 *
 *  A job is billed when it is FINISHED, which on this board means the Finish
 *  column and nothing else. Done is excluded deliberately — a card only
 *  reaches Done once it has been settled, so offering to raise a FIRST
 *  invoice there would be offering to bill a job that by definition was
 *  already billed.
 *
 *  `quote_invoiced` is the local "already billed" signal. The create route
 *  writes it the moment Books confirms, so the button disappears on the next
 *  board refetch rather than waiting an hour for the sync sweep. The server
 *  still checks Books itself before creating anything, because a bill raised
 *  by hand directly in Books does lag by that hour — the button reappearing
 *  for it is harmless, since the dialog's own preview refuses first, with the
 *  real reason.
 *
 *  A pending sync is not a reason to hide the button. Billing while an edit
 *  is still on its way to Books would issue a document for the lines as they
 *  were BEFORE it landed — so the invoice routes push the card first and wait
 *  for it (`ensure_pushed`), and refuse with `sync_pending` if it does not
 *  land.
 */
export function canCreateInvoice(project: AitoProject): boolean {
  return project.column === 'finish' && Boolean(project.quote_id) && !project.quote_invoiced;
}
