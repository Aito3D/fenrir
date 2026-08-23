/**
 * Unit test for useSortToggle (T-079): the sort-key/direction state shared by
 * CalculatorFilamentsPanel and CalculatorPrintersPanel. Exercised directly
 * here — smaller surface than mounting a whole panel — and again indirectly
 * in CalculatorSettingsPanels.test.tsx's "toggles sort direction on repeated
 * header clicks" test, which is what proves the panels actually use this
 * hook rather than a leftover copy of the old inline logic.
 */

import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSortToggle } from '../../components/calculator/calculatorSettingsShared';

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
