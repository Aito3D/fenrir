import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectItemOut, ProjectSection } from '../../../api/client';
import { CollapsibleHeader } from './CollapsibleHeader';
import { ItemRow } from './ItemRow';
import { SectionBlock } from './SectionBlock';
import type { DerivedOption } from './RevisionBlock';
import { useFileActions } from './useFileActions';
import { PrintRevisionFlow } from '../print/PrintRevisionFlow';
import type { FileActions } from './useFileActions';
import { ENABLED_SECTIONS, SECTION_LABEL_KEYS, SECTION_ORDER, isSectionEnabled } from './filesUi';
import { revisionLabel } from './revisionLabel';
import { useProjectTree } from '../projectQueries';

export function ProjectFilesPanel({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const actions = useFileActions(projectId);
  const { data: tree } = useProjectTree(projectId);

  const derivedOptions = useMemo<DerivedOption[]>(
    () =>
      (tree?.sections ?? []).flatMap((s) =>
        s.items.flatMap((item) =>
          item.revisions.map((r) => ({ id: r.id, label: `${t(SECTION_LABEL_KEYS[s.section])} › ${revisionLabel(item.name, r.number)}` })),
        ),
      ),
    [tree, t],
  );

  if (!tree) return null;
  const bySection = new Map(tree.sections.map((s) => [s.section, s.items]));
  // Projects hold printing files only for now: only the enabled sections are shown;
  // items left in a disabled one stay reachable under "Older files".
  const legacy = SECTION_ORDER.filter((section) => !isSectionEnabled(section))
    .map((section) => ({ section, items: bySection.get(section) ?? [] }))
    .filter((s) => s.items.length > 0);
  return (
    <div className="space-y-3">
      {ENABLED_SECTIONS.map((section) => (
        <SectionBlock key={section} section={section} items={bySection.get(section) ?? []} derivedOptions={derivedOptions} actions={actions} />
      ))}
      {legacy.length > 0 && <OlderFiles sections={legacy} derivedOptions={derivedOptions} actions={actions} />}
      {actions.reslice.printNext && (
        <PrintRevisionFlow
          key={actions.reslice.printNext.file.id}
          projectId={projectId}
          file={actions.reslice.printNext.file}
          initialTaskId={actions.reslice.printNext.taskId}
          onClose={actions.reslice.clearPrintNext}
        />
      )}
    </div>
  );
}

/** Items still in a disabled section, collapsed by default and read-only except delete. */
function OlderFiles({
  sections,
  derivedOptions,
  actions,
}: {
  sections: { section: ProjectSection; items: ProjectItemOut[] }[];
  derivedOptions: DerivedOption[];
  actions: FileActions;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const count = sections.reduce((n, s) => n + s.items.length, 0);
  return (
    <section data-testid="older-files" className="rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
      <div className="p-2">
        <h3 className="text-sm font-semibold text-white">
          <CollapsibleHeader open={open} onToggle={() => setOpen((o) => !o)} label={t('projectsPdm.files.otherSections')} count={count} />
        </h3>
      </div>
      {open && (
        <div className="space-y-3 px-2 pb-2">
          {sections.map((s) => (
            <div key={s.section} className="space-y-2">
              <h4 className="px-1 text-xs font-semibold uppercase tracking-wide text-bambu-gray">{t(SECTION_LABEL_KEYS[s.section])}</h4>
              <ul className="space-y-2">
                {s.items.map((item) => <ItemRow key={item.id} item={item} derivedOptions={derivedOptions} actions={actions} />)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
