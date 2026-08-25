/**
 * Filament profile view preferences.
 *
 * These are browser-local preferences for filtering and displaying filament
 * profiles. They describe how the user wants their own screen to look and do
 * not persist to the backend.
 */

import type { GridSize } from '../components/filament-profiles/types';

const BRAND_FILTER_KEY = 'profiles-filter-brand';
const MATERIAL_FILTER_KEY = 'profiles-filter-material';
const GRID_SIZE_KEY = 'profiles-grid-size';

export function readBrandFilter(): string {
  try {
    const saved = localStorage.getItem(BRAND_FILTER_KEY);
    return saved ?? '';
  } catch {
    // Quota exceeded or private mode — return default.
    return '';
  }
}

export function writeBrandFilter(v: string): void {
  try {
    localStorage.setItem(BRAND_FILTER_KEY, v);
  } catch {
    // Quota exceeded or private mode — no-op.
  }
}

export function readMaterialFilter(): string {
  try {
    const saved = localStorage.getItem(MATERIAL_FILTER_KEY);
    return saved ?? '';
  } catch {
    // Quota exceeded or private mode — return default.
    return '';
  }
}

export function writeMaterialFilter(v: string): void {
  try {
    localStorage.setItem(MATERIAL_FILTER_KEY, v);
  } catch {
    // Quota exceeded or private mode — no-op.
  }
}

export function readGridSize(): GridSize {
  try {
    const saved = localStorage.getItem(GRID_SIZE_KEY);
    if (!saved) return 'medium';
    if (!['small', 'medium', 'large'].includes(saved)) return 'medium';
    return saved as GridSize;
  } catch {
    // Quota exceeded or private mode — return default.
    return 'medium';
  }
}

export function writeGridSize(v: GridSize): void {
  try {
    localStorage.setItem(GRID_SIZE_KEY, v);
  } catch {
    // Quota exceeded or private mode — no-op.
  }
}
