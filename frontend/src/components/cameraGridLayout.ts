import type { ComponentType } from 'react';
import { Grid, Grid2x2, LayoutGrid } from 'lucide-react';

export type GridLayout = 'compact' | 'default' | 'large';

export const GRID_LAYOUT_COLS: Record<GridLayout, string> = {
  compact: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6',
  default: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5',
  large:   'grid-cols-1 sm:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4',
};

export const GRID_LAYOUT_ICONS: Record<GridLayout, ComponentType<{ className?: string }>> = {
  compact: Grid,
  default: Grid2x2,
  large: LayoutGrid,
};
