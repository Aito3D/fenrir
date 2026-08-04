import { parseUTCDate } from './date';
import type { AitoProject } from '../api/client';

/** Lowercase and strip combining marks, so a typed `camera` finds `caméra`.
 *  Applied to BOTH sides: the deployment is French-facing, and accented input
 *  is the exception rather than the rule — folding only the haystack would
 *  still fail the user who does type the accent. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** One card's searchable text: its description — which is also its title, as
 *  `AitoProject` has no separate field — plus the client it belongs to and its
 *  Zoho quote number. Both of the latter are nullable on hand-made cards. */
function haystack(project: AitoProject): string {
  return fold([project.description, project.client_name, project.quote_number].filter(Boolean).join(' '));
}

/** Every whitespace-separated term must appear somewhere in the card's text.
 *
 *  ANDing terms rather than substring-matching the raw query is what lets
 *  `dupont gopro` find a card whose client supplies one word and whose
 *  description supplies the other. An empty or whitespace-only query matches
 *  everything, so the board renders unfiltered before the user types. */
export function matchesSearch(project: AitoProject, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(project);
  return terms.every((term) => text.includes(term));
}

/** Search-filtered projects, most recently updated first — the shared body
 *  behind both archive grids (Done, Trash). Neither is the board: both are
 *  flat, ever-growing lists where the stored `position`/column order is
 *  meaningless (drop-order history for Done, arbitrary for Trash), so both
 *  reorder by `updated_at` instead. */
export function sortByRecencyDesc(projects: AitoProject[], query: string): AitoProject[] {
  // `parseUTCDate`, not a string compare: the board's timestamps are
  // inconsistently suffixed ('…:00Z' on some rows, '…:00' on others) and a
  // lexical compare orders those two forms by their suffix, not their
  // instant. Ties break on id descending so the order is stable.
  const time = (project: AitoProject) => parseUTCDate(project.updated_at)?.getTime() ?? 0;
  return projects
    .filter((project) => matchesSearch(project, query))
    .slice()
    .sort((a, b) => time(b) - time(a) || b.id - a.id);
}
