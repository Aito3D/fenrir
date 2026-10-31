import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowRight, Box, Flame, Folder, Tag, User } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectCatalogItem, ProjectFolder } from '../../../api/client';
import { focusRingCls } from '../../formStyles';
import { ProjectCodeChip } from '../ProjectCodeChip';
import { ProjectFilesPanel } from '../files/ProjectFilesPanel';
import { CatalogTitle } from './CatalogTitle';
import { formatRelativeTime } from '../../../utils/date';
import { folderPath } from './catalogRules';

/** The selected project: its facts (no printer line: each file carries its own setup), then the
 *  project page's own printing-files panel (same cards, Print, preview, download and upload).
 *  The title renames in place; "Open project" goes to the full page. */
export function CatalogPane({ item, folders }: { item: ProjectCatalogItem; folders: ProjectFolder[] }) {
  const { t } = useTranslation();
  const path = folderPath(folders, item.folder_id);
  const printed = item.target_count
    ? t('projectsPdm.catalog.printedOf', { n: item.printed_count, target: item.target_count })
    : item.printed_count > 0
      ? t('projectsPdm.catalog.printed', { n: item.printed_count })
      : t('projectsPdm.catalog.neverPrinted');
  return (
    <div data-testid="catalog-pane" className="space-y-4">
      {path.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-bambu-gray"><Folder className="h-3 w-3" aria-hidden />{path.join(' › ')}</nav>
      )}
      <div className="flex items-start gap-3 border-b border-bambu-dark-tertiary pb-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark">
          {item.thumbnail_file_id !== null ? (
            <img src={api.getLibraryFileThumbnailUrl(item.thumbnail_file_id)} alt="" className="h-full w-full object-cover brightness-125 contrast-110" />
          ) : (
            <Box className="h-6 w-6 text-bambu-gray/40" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectCodeChip code={item.code} />
            <CatalogTitle projectId={item.id} name={item.name} />
            {item.open_orders.map((o) => (
              <span key={o.order_id} className="flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300">
                <Flame className="h-3 w-3" aria-hidden />{`#${o.order_id}${o.client_name ? ` · ${o.client_name}` : ''}`}
              </span>
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-bambu-gray">
            {item.client_names.length > 0 && <span className="flex items-center gap-1"><User className="h-3 w-3" aria-hidden />{item.client_names.join(', ')}</span>}
            <span>{printed}</span>
            <span>{formatRelativeTime(item.last_activity, 'system', t)}</span>
            {item.tags.length > 0 && <span className="flex items-center gap-1"><Tag className="h-3 w-3" aria-hidden />{item.tags.map((x) => x.name).join(', ')}</span>}
          </div>
          {item.description && <p className="mt-1 line-clamp-2 text-xs text-bambu-gray">{item.description}</p>}
        </div>
        <Link to={`/projects/${item.id}`}
          className={`flex shrink-0 items-center gap-1 rounded-lg border border-bambu-dark-tertiary px-2.5 py-1.5 text-xs text-bambu-gray hover:text-white ${focusRingCls}`}>
          {t('projectsPdm.catalog.openProject')}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <ProjectFilesPanel projectId={item.id} />
    </div>
  );
}
