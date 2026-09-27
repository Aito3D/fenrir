import type { AitoProject } from '../api/client';
import type { ColumnMeta } from '../components/aito/columns';
import { ageAnchor, agingColorCls } from './aitoAging';

const DAY_MS = 86_400_000;

/** What the mobile header and column sheet say about one column. */
export interface ColumnSummary {
  column: ColumnMeta;
  count: number;
  /** Whole days since the oldest card's age anchor — the same clock the
   *  card's own footer runs on (ageAnchor). Null for an empty column. */
  oldestDays: number | null;
  /** The oldest card's heat-ramp colour class (agingColorCls), '' when none. */
  oldestCls: string;
}

export function summariseColumn(column: ColumnMeta, projects: AitoProject[], now: number): ColumnSummary {
  let oldest: { project: AitoProject; at: Date } | null = null;
  for (const project of projects) {
    const { at } = ageAnchor(project);
    if (at && (oldest === null || at.getTime() < oldest.at.getTime())) oldest = { project, at };
  }
  if (oldest === null) return { column, count: projects.length, oldestDays: null, oldestCls: '' };
  return {
    column,
    count: projects.length,
    oldestDays: Math.max(0, Math.floor((now - oldest.at.getTime()) / DAY_MS)),
    oldestCls: agingColorCls(oldest.project, oldest.at, now),
  };
}
