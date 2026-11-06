import { useMemo } from 'react';
import type { TFunction } from 'i18next';
import { Archive, BarChart3, Trash2 } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import type { ColumnMeta } from './columns';
import type { ActionMenuItem } from './ActionMenu';
import { summariseColumn } from '../../utils/aitoMobileBoard';

/** The ⋯ menu's three views entries, the same on both touch boards. */
export function moreMenuViewItems(
  t: TFunction,
  pending: boolean,
  doneCount: number,
  onShowView: (view: 'done' | 'trash' | 'stats') => void,
): ActionMenuItem[] {
  return [
    {
      key: 'done',
      icon: Archive,
      label: t('aito.showDone'),
      trailing: pending ? '–' : doneCount,
      onSelect: () => onShowView('done'),
    },
    { key: 'trash', icon: Trash2, label: t('aito.trash'), onSelect: () => onShowView('trash') },
    { key: 'stats', icon: BarChart3, label: t('aito.statistics'), onSelect: () => onShowView('stats') },
  ];
}

export function useColumnSummaries(columns: { column: ColumnMeta; projects: AitoProject[] }[], now: number) {
  return useMemo(() => columns.map(({ column, projects }) => summariseColumn(column, projects, now)), [columns, now]);
}
