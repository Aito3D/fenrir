import type { AitoProject } from '../../api/client';

/** Which board cards may be merged into `project`: every other active card
 *  that is not invoiced (its lines are accounting and stay where they were
 *  billed — the server refuses them too). The same client's cards come
 *  first: a merge is nearly always "the second half of the same job".
 *
 *  Its own module (not exported from MergeProjectModal.tsx) so the modal's
 *  file exports only a component — Fast Refresh's rule, enforced by ESLint. */
export function mergeCandidates(board: AitoProject[], project: AitoProject): AitoProject[] {
  const others = board.filter((p) => p.id !== project.id && p.status === 'active' && !p.quote_invoiced);
  const same = others.filter((p) => project.client_id !== null && p.client_id === project.client_id);
  const rest = others.filter((p) => !same.includes(p));
  return [...same, ...rest];
}

/** Case-insensitive match over the things an operator quotes back to a
 *  client: the description, the client's name, the quote number, `#id`. */
export function matchesCandidate(p: AitoProject, needle: string): boolean {
  if (!needle) return true;
  const hay = [p.description, p.client_name ?? '', p.quote_number ?? '', `#${p.id}`].join(' ').toLowerCase();
  return hay.includes(needle);
}
