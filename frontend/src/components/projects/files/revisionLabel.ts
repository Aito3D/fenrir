import type { TFunction } from 'i18next';
import type { ProjectSection, RevisionRef } from '../../../api/client';
import { SECTION_LABEL_KEYS } from './filesUi';

/** `R3`: the bare revision number label, as a revision is shown inside its own item. */
export function revisionNumberLabel(number: number): string {
  return `R${number}`;
}

/** `Support R3`: the item name and revision number, as every project view labels a revision. */
export function revisionLabel(name: string, number: number): string {
  return `${name} ${revisionNumberLabel(number)}`;
}

/** `Impression › Support R3`: the section label, then the revision label, as derived-from pickers name a revision. */
export function sectionRevisionLabel(t: TFunction, section: ProjectSection, itemName: string, number: number): string {
  return `${t(SECTION_LABEL_KEYS[section])} › ${revisionLabel(itemName, number)}`;
}

/** `{ source, newer }` for the `outdated` / `outdatedWarning` strings: `Support R1` and `R2`. */
export function outdatedParams(
  src: Pick<RevisionRef, 'item_name' | 'number'>,
  newer: Pick<RevisionRef, 'number'>,
): { source: string; newer: string } {
  return { source: revisionLabel(src.item_name, src.number), newer: revisionNumberLabel(newer.number) };
}
