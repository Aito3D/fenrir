import type { RevisionRef } from '../../../api/client';

/** `Support R3`: the item name and revision number, as every project view labels a revision. */
export function revisionLabel(name: string, number: number): string {
  return `${name} R${number}`;
}

/** `{ source, newer }` for the `outdated` / `outdatedWarning` strings: `Support R1` and `R2`. */
export function outdatedParams(
  src: Pick<RevisionRef, 'item_name' | 'number'>,
  newer: Pick<RevisionRef, 'number'>,
): { source: string; newer: string } {
  return { source: revisionLabel(src.item_name, src.number), newer: `R${newer.number}` };
}
