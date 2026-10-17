import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { DerivedOption } from './RevisionBlock';
import { sectionRevisionLabel } from './revisionLabel';
import { useProjectTree } from '../projectQueries';

/** Every revision of the project as a derived-from choice (`Printing › Support R3`), from the
 *  cached project tree. */
export function useDerivedOptions(projectId: number): DerivedOption[] {
  const { t } = useTranslation();
  // Reads the panel's cached tree: a tray opening must not refetch it.
  const { data: tree } = useProjectTree(projectId, { refetchOnMount: false });
  return useMemo<DerivedOption[]>(
    () =>
      (tree?.sections ?? []).flatMap((s) =>
        s.items.flatMap((item) =>
          item.revisions.map((r) => ({ id: r.id, label: sectionRevisionLabel(t, s.section, item.name, r.number) })),
        ),
      ),
    [tree, t],
  );
}
