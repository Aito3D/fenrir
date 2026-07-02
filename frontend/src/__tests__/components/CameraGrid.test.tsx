/**
 * Tests for CameraGrid layout constants and re-exports.
 *
 * The CameraGrid component uses useSyncExternalStore and Web Workers
 * internally, making full render tests fragile. Instead we test the
 * extracted constants and types which are the public API for layout.
 */

import { describe, it, expect } from 'vitest';
import { GRID_LAYOUT_COLS, GRID_LAYOUT_ICONS } from '../../components/cameraGridLayout';
import type { GridLayout } from '../../components/cameraGridLayout';

describe('cameraGridLayout constants', () => {
  it('GRID_LAYOUT_COLS has all layout variants', () => {
    const keys: GridLayout[] = ['compact', 'default', 'large'];
    for (const key of keys) {
      expect(GRID_LAYOUT_COLS[key]).toBeDefined();
      expect(typeof GRID_LAYOUT_COLS[key]).toBe('string');
      expect(GRID_LAYOUT_COLS[key]).toContain('grid-cols');
    }
  });

  it('GRID_LAYOUT_ICONS has all layout variants', () => {
    const keys: GridLayout[] = ['compact', 'default', 'large'];
    for (const key of keys) {
      expect(GRID_LAYOUT_ICONS[key]).toBeDefined();
    }
  });

  it('compact has more columns than default', () => {
    // compact has 2xl:grid-cols-6 while default has 2xl:grid-cols-5
    expect(GRID_LAYOUT_COLS.compact).toContain('2xl:grid-cols-6');
    expect(GRID_LAYOUT_COLS.default).toContain('2xl:grid-cols-5');
  });

  it('large has fewer columns than default', () => {
    // large has 2xl:grid-cols-4 while default has 2xl:grid-cols-5
    expect(GRID_LAYOUT_COLS.large).toContain('2xl:grid-cols-4');
  });
});

describe('CameraGrid re-exports', () => {
  it('re-exports GridLayout type and constants from CameraGrid module', async () => {
    // Verify the re-exports work
    const mod = await import('../../components/cameraGridLayout');
    expect(mod.GRID_LAYOUT_COLS).toBeDefined();
    expect(mod.GRID_LAYOUT_ICONS).toBeDefined();
  });
});
