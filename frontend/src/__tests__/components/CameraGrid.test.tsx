/**
 * Tests for CameraGrid layout constants and re-exports.
 *
 * The CameraGrid component uses useSyncExternalStore and Web Workers
 * internally, making full render tests fragile. Instead we test the
 * extracted constants and types which are the public API for layout.
 */

import { describe, it, expect } from 'vitest';
import {
  GRID_LAYOUT_COLS,
  GRID_LAYOUT_ICONS,
  GRID_BLINK_PERIOD_MS,
  gridBlinkSyncStyle,
  gridCardHighlightClass,
} from '../../components/cameraGridLayout';
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

describe('gridCardHighlightClass', () => {
  const base = { connected: true, plateCleared: false, hasQueuedJobs: false };

  it('running: steady green border with glow, no blink', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'RUNNING' });
    expect(cls).toContain('!border-bambu-green');
    expect(cls).toContain('!shadow-');
    expect(cls).not.toContain('animate-grid-border-blink');
  });

  it('paused: blink with default (yellow) color', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'PAUSE' });
    expect(cls).toBe('animate-grid-border-blink');
  });

  it('finished: blue blink with glow — ready for pickup, distinct from printing green', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'FINISH' });
    expect(cls).toContain('animate-grid-border-blink');
    expect(cls).toContain('[--blink-color:rgb(96_165_250)]'); // blue-400, matches status legend
    expect(cls).toContain('!shadow-');
    expect(cls).not.toContain('--accent'); // green is reserved for printing
    // Blink branches must never carry !border-* (kills the animation)
    expect(cls).not.toContain('!border-');
  });

  it('finished but queue confirmed plate cleared: no highlight', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'FINISH', plateCleared: true, hasQueuedJobs: true });
    expect(cls).toBe('!border-transparent');
  });

  it('finished with plateCleared default-true but no queue: still highlights', () => {
    // plateCleared defaults to true for non-queue users — must not suppress
    const cls = gridCardHighlightClass({ ...base, state: 'FINISH', plateCleared: true, hasQueuedJobs: false });
    expect(cls).toContain('animate-grid-border-blink');
  });

  it('failed: red blink without glow', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'FAILED' });
    expect(cls).toContain('animate-grid-border-blink');
    expect(cls).toContain('[--blink-color:rgb(248_113_113)]');
    expect(cls).not.toContain('!shadow-');
    expect(cls).not.toContain('!border-');
  });

  it('disconnected: no highlight regardless of state', () => {
    for (const state of ['RUNNING', 'PAUSE', 'FINISH', 'FAILED']) {
      expect(gridCardHighlightClass({ ...base, connected: false, state })).toBe('!border-transparent');
    }
  });

  it('idle/unknown states: no highlight', () => {
    expect(gridCardHighlightClass({ ...base, state: 'IDLE' })).toBe('!border-transparent');
    expect(gridCardHighlightClass({ ...base, state: null })).toBe('!border-transparent');
  });
});

describe('gridBlinkSyncStyle', () => {
  it('returns undefined for non-blinking highlight classes', () => {
    expect(gridBlinkSyncStyle('!border-transparent')).toBeUndefined();
    expect(gridBlinkSyncStyle('!border-bambu-green !shadow-[...]')).toBeUndefined();
  });

  it('returns a negative delay within one blink period', () => {
    const style = gridBlinkSyncStyle('animate-grid-border-blink', 12_345);
    expect(style).toBeDefined();
    const delay = parseInt(style!.animationDelay, 10);
    expect(delay).toBeLessThanOrEqual(0);
    expect(delay).toBeGreaterThan(-GRID_BLINK_PERIOD_MS);
  });

  it('aligns cards mounted at different times to the same phase', () => {
    // Two mounts one full period apart share the exact same delay
    const a = gridBlinkSyncStyle('animate-grid-border-blink', 10_000);
    const b = gridBlinkSyncStyle('animate-grid-border-blink', 10_000 + GRID_BLINK_PERIOD_MS);
    expect(a!.animationDelay).toBe(b!.animationDelay);
    // A mount mid-period gets a delay that offsets it back to the epoch phase
    const c = gridBlinkSyncStyle('animate-grid-border-blink', 10_000 + 500);
    const delayA = parseInt(a!.animationDelay, 10);
    const delayC = parseInt(c!.animationDelay, 10);
    expect(delayA - delayC).toBe(500);
  });
});
