import type { ProjectStats } from '../../../api/client';

export function formatFilament(grams: number): string {
  if (grams >= 1000) {
    return `${(grams / 1000).toFixed(2)}kg`;
  }
  return `${Math.round(grams)}g`;
}

/** The project's running cost: filament + energy + printer wear (no BOM). */
export function projectCost(stats: Pick<ProjectStats, 'estimated_cost' | 'total_energy_cost' | 'total_wear_cost'>): number {
  return stats.estimated_cost + stats.total_energy_cost + (stats.total_wear_cost ?? 0);
}
