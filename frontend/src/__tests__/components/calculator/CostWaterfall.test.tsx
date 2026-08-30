/**
 * T-037: CostWaterfall had no dedicated test — in particular its
 * `steps.length === 0 || total <= 0` hide-guard was only ever exercised via
 * the empty-steps arm (no `steps` at all). `buildWaterfall` can now keep a
 * genuinely negative `marge` as its own signed step while `total_ttc` stays
 * positive (pricing.test.ts), but a caller could still hand CostWaterfall a
 * `steps` array whose last cumulative (== total_ttc) is zero or negative —
 * that arm of the guard is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostWaterfall } from '../../../components/calculator/CostWaterfall';
import type { WaterfallStep } from '../../../utils/pricing';

describe('CostWaterfall', () => {
  it('renders one segment per step, positioned/sized by cumulative share of the total, plus a legend', () => {
    const steps: WaterfallStep[] = [
      { key: 'filament', value: 40, cumulative: 40 },
      { key: 'printer', value: 20, cumulative: 60 },
      { key: 'marge', value: 10, cumulative: 70 },
      { key: 'tax', value: 30, cumulative: 100 },
    ];
    const { container } = render(<CostWaterfall steps={steps} currency="USD" />);

    const track = screen.getByRole('img', { name: 'Price build-up from costs to final price' });
    expect(track).toBeInTheDocument();

    const segments = container.querySelectorAll('.waterfall-seg');
    expect(segments).toHaveLength(4);

    // filament: starts at 0, spans 40% of the 100 total.
    const filamentSeg = segments[0] as HTMLElement;
    expect(filamentSeg.style.left).toBe('0%');
    expect(filamentSeg.style.width).toBe('max(40%, 3px)');
    expect(filamentSeg.style.backgroundColor).toBe('var(--viz-1)');
    expect(filamentSeg.title).toBe('Filament: $40.00 (40.0%) — $40.00');

    // printer: starts where filament ended (40%), spans 20%.
    const printerSeg = segments[1] as HTMLElement;
    expect(printerSeg.style.left).toBe('40%');
    expect(printerSeg.style.width).toBe('max(20%, 3px)');
    expect(printerSeg.title).toBe('Printer: $20.00 (20.0%) — $60.00');

    // marge: the one green ("kept") step, starts at 60%, spans 10%.
    const margeSeg = segments[2] as HTMLElement;
    expect(margeSeg.style.left).toBe('60%');
    expect(margeSeg.style.width).toBe('max(10%, 3px)');
    expect(margeSeg.style.backgroundColor).toBe('var(--color-bambu-green)');
    expect(margeSeg.className).not.toContain('waterfall-seg-tax');

    // tax: hatched (transparent bg + dedicated class), starts at 70%, spans 30%.
    const taxSeg = segments[3] as HTMLElement;
    expect(taxSeg.style.left).toBe('70%');
    expect(taxSeg.style.width).toBe('max(30%, 3px)');
    expect(taxSeg.className).toContain('waterfall-seg-tax');
    expect(taxSeg.title).toBe('Tax: $30.00 (30.0%) — $100.00');

    // Legend lists every step's label + share of total (label and percent
    // are sibling text/nodes inside the same <span>, so assert on the
    // whole item's text rather than querying for the label alone).
    const legendItems = container.querySelectorAll('.gap-x-4.gap-y-1 > span');
    expect(Array.from(legendItems).map((el) => el.textContent)).toEqual([
      'Filament · 40.0%',
      'Printer · 20.0%',
      'Margin · 10.0%',
      'Tax · 30.0%',
    ]);
  });

  it('renders nothing when steps is empty', () => {
    const { container } = render(<CostWaterfall steps={[]} currency="USD" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the last cumulative (total_ttc) is exactly zero, even with non-empty steps', () => {
    const steps: WaterfallStep[] = [
      { key: 'filament', value: 40, cumulative: 40 },
      { key: 'marge', value: -40, cumulative: 0 },
    ];
    const { container } = render(<CostWaterfall steps={steps} currency="USD" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the last cumulative (total_ttc) is negative, even with non-empty steps', () => {
    const steps: WaterfallStep[] = [
      { key: 'filament', value: 40, cumulative: 40 },
      { key: 'marge', value: -60, cumulative: -20 },
    ];
    const { container } = render(<CostWaterfall steps={steps} currency="USD" />);
    expect(container).toBeEmptyDOMElement();
  });
});
