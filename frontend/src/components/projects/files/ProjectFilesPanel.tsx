import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { SectionBlock } from './SectionBlock';
import type { DerivedOption } from './RevisionBlock';
import { useFileActions } from './useFileActions';
import { SECTION_LABEL_KEYS, SECTION_ORDER } from './filesUi';

export function ProjectFilesPanel({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const actions = useFileActions(projectId);
  const { data: tree } = useQuery({ queryKey: ['project-tree', projectId], queryFn: () => api.getProjectTree(projectId) });

  const derivedOptions = useMemo<DerivedOption[]>(
    () =>
      (tree?.sections ?? []).flatMap((s) =>
        s.items.flatMap((item) =>
          item.revisions.map((r) => ({ id: r.id, label: `${t(SECTION_LABEL_KEYS[s.section])} › ${item.name} R${r.number}` })),
        ),
      ),
    [tree, t],
  );

  if (!tree) return null;
  const bySection = new Map(tree.sections.map((s) => [s.section, s.items]));
  return (
    <div className="space-y-3">
      {SECTION_ORDER.map((section) => (
        <SectionBlock key={section} section={section} items={bySection.get(section) ?? []} derivedOptions={derivedOptions} actions={actions} />
      ))}
    </div>
  );
}
