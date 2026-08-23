/**
 * Unit tests for calculatorSettingsShared's two exported helpers:
 *
 * - useSortToggle (T-079): the sort-key/direction state shared by
 *   CalculatorFilamentsPanel and CalculatorPrintersPanel. Exercised directly
 *   here — smaller surface than mounting a whole panel — and again indirectly
 *   in CalculatorSettingsPanels.test.tsx's "toggles sort direction on
 *   repeated header clicks" test, which is what proves the panels actually
 *   use this hook rather than a leftover copy of the old inline logic.
 *
 * - parseNum (T-103): the string -> number-or-null parser behind every
 *   NumberField's value and behind CalculatorDefaultsPanel's `allValid` save
 *   gate. Its `Number.isFinite` guard against 'Infinity'/'-Infinity'/'NaN'
 *   was previously untested here — grep for 'parseNum' in this file used to
 *   return nothing, even though CalculatorSettingsPanels.test.tsx imports
 *   from this same module. See CalculatorSettingsPanels.test.tsx's
 *   "CalculatorDefaultsPanel disables Save" describe block for the
 *   integration-level proof that the gate is actually wired to this
 *   function.
 */

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { parseNum, useSortToggle } from '../../components/calculator/calculatorSettingsShared';

describe('useSortToggle', () => {
  it('starts at the given key, ascending', () => {
    const { result } = renderHook(() => useSortToggle<'name' | 'cost'>('name'));
    expect(result.current.sortKey).toBe('name');
    expect(result.current.sortDir).toBe('asc');
  });

  it('selecting a different column switches to it ascending', () => {
    const { result } = renderHook(() => useSortToggle<'name' | 'cost'>('name'));
    act(() => result.current.toggleSort('cost'));
    expect(result.current.sortKey).toBe('cost');
    expect(result.current.sortDir).toBe('asc');
  });

  it('clicking the already-active column flips direction back and forth', () => {
    const { result } = renderHook(() => useSortToggle<'name' | 'cost'>('name'));
    act(() => result.current.toggleSort('name'));
    expect(result.current.sortKey).toBe('name');
    expect(result.current.sortDir).toBe('desc');

    act(() => result.current.toggleSort('name'));
    expect(result.current.sortDir).toBe('asc');
  });

  it('switching to a new column always resets direction to ascending, even mid-descending', () => {
    const { result } = renderHook(() => useSortToggle<'name' | 'cost'>('name'));
    act(() => result.current.toggleSort('name')); // now desc
    act(() => result.current.toggleSort('cost')); // switch column
    expect(result.current.sortKey).toBe('cost');
    expect(result.current.sortDir).toBe('asc');
  });
});

describe('parseNum', () => {
  it('parses an ordinary decimal string', () => {
    expect(parseNum('42.5')).toBe(42.5);
  });

  it('parses a negative number (the >= 0 floor is a separate caller-side check, not parseNum\'s job)', () => {
    expect(parseNum('-5')).toBe(-5);
  });

  it('returns null for an empty string', () => {
    expect(parseNum('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseNum('   ')).toBeNull();
  });

  it('trims surrounding whitespace around an otherwise valid number', () => {
    // Number() itself trims whitespace; parseNum's own trim() check only
    // short-circuits the empty/whitespace-only case above.
    expect(parseNum('  42  ')).toBe(42);
  });

  it('returns null for non-numeric text', () => {
    expect(parseNum('abc')).toBeNull();
  });

  it('returns null for a number with trailing non-numeric characters (unlike parseInt/parseFloat, which would return 12)', () => {
    expect(parseNum('12abc')).toBeNull();
  });

  // The Number.isFinite guard this task pins: without it, Number('Infinity'),
  // Number('-Infinity') and Number('NaN') would sail straight through as a
  // non-null return, and CalculatorDefaultsPanel's `allValid` gate
  // (`n !== null && n >= 0`) would accept all three — Infinity and
  // -Infinity pass a `>= 0` check trivially (false only for -Infinity,
  // which is why 'NaN' is the case that most needs this guard: NaN >= 0 is
  // also false, but only by the coincidence of NaN comparisons always being
  // false, not because anything actually checked it was a real number).
  it('returns null for "Infinity"', () => {
    expect(parseNum('Infinity')).toBeNull();
  });

  it('returns null for "-Infinity"', () => {
    expect(parseNum('-Infinity')).toBeNull();
  });

  it('returns null for "NaN"', () => {
    expect(parseNum('NaN')).toBeNull();
  });
});
