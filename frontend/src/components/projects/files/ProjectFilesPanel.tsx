import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectItemOut, ProjectSection } from '../../../api/client';
import { focusRingCls } from '../../formStyles';
import { ItemRow } from './ItemRow';
import { SectionBlock } from './SectionBlock';
import type { DerivedOption } from './RevisionBlock';
import { useFileActions } from './useFileActions';
import { PrintRevisionFlow } from '../print/PrintRevisionFlow';
import type { FileActions } from './useFileActions';
import { ENABLED_SECTIONS, SECTION_LABEL_KEYS, SECTION_ORDER, isSectionEnabled } from './filesUi';

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
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            className={`flex min-h-[44px] w-full items-center gap-1.5 rounded-lg text-left md:min-h-0 ${focusRingCls}`}>
            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-bambu-gray" /> : <ChevronRight className="h-4 w-4 shrink-0 text-bambu-gray" />}
            <span>{t('projectsPdm.files.otherSections')}</span>{' '}
            <span className="text-xs font-normal text-bambu-gray">{count}</span>
          </button>
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
