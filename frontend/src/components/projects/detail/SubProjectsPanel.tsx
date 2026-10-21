import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderTree } from 'lucide-react';
import type { ProjectChildPreview } from '../../../api/client';
import { ProjectPanel } from './ProjectPanel';
import { formatFilament } from './format';

/** The project's direct sub-projects, one link row each with its own branch's figures (#1264). */
export function SubProjectsPanel({ subProjects, currency }: { subProjects: ProjectChildPreview[]; currency: string }) {
  const { t } = useTranslation();
  return (
    <ProjectPanel icon={FolderTree} title={t('projectDetail.subProjects.title', { count: subProjects.length })}>
      <div className="space-y-2">
        {subProjects.map((child) => (
          <Link
            key={child.id}
            to={`/projects/${child.id}`}
            className="flex items-center justify-between gap-4 p-3 bg-bambu-dark rounded-lg hover:bg-bambu-dark-tertiary transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: child.color || '#6b7280' }}
              />
              <span className="text-white truncate">{child.name}</span>
              <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                child.status === 'completed' ? 'bg-status-ok/20 text-status-ok' :
                child.status === 'archived' ? 'bg-bambu-gray/20 text-bambu-gray' :
                'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400'
              }`}>
                {child.status}
              </span>
              {/* A branch of its own, so its figures cover more than the
                  one project named on this row (#1264). */}
              {child.descendant_count > 0 && (
                <span className="text-xs text-bambu-gray flex-shrink-0 inline-flex items-center gap-1">
                  <FolderTree className="w-3 h-3" />
                  {child.descendant_count}
                </span>
              )}
            </div>
            {/* Each row carries its own branch's roll-up, so the rows add
                up to the header's roll-up line minus this project's own prints. */}
            <div className="flex items-center gap-4 text-sm text-bambu-gray flex-shrink-0">
              {child.total_archives > 0 && (
                <span className="hidden sm:inline">
                  {t('projectDetail.subProjects.jobs', { count: child.total_archives })}
                </span>
              )}
              {child.total_filament_grams > 0 && (
                <span className="hidden md:inline">{formatFilament(child.total_filament_grams)}</span>
              )}
              {child.total_cost > 0 && (
                <span className="hidden md:inline">{currency}{child.total_cost.toFixed(2)}</span>
              )}
              {child.progress_percent !== null && (
                <span>{child.progress_percent.toFixed(0)}%</span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </ProjectPanel>
  );
}
