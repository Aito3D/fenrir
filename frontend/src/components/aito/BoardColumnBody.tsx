import { useTranslation } from 'react-i18next';
import type { AitoProject } from '../../api/client';
import { CompactBoardCard } from './CompactBoardCard';

/** A column's cards, or its empty state — the body the phone and tablet boards share. */
export function BoardColumnBody({
  projects,
  pending,
  filtering,
  onExpandCard,
}: {
  projects: AitoProject[];
  pending: boolean;
  filtering: boolean;
  onExpandCard: (id: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {projects.map((project) => (
        <CompactBoardCard key={project.id} project={project} onExpand={() => onExpandCard(project.id)} />
      ))}
      {projects.length === 0 &&
        !pending &&
        (filtering ? (
          <p className="py-8 text-center text-sm text-bambu-gray">{t('aito.searchNoResults')}</p>
        ) : (
          <div className="animate-fade-in min-h-[8rem] rounded-lg border border-dashed border-bambu-dark-tertiary/80" />
        ))}
    </>
  );
}
