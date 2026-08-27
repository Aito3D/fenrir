import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CalculatorQuantityCurve } from '../../components/calculator/CalculatorQuantityCurve';
import type { CurvePoint } from '../../utils/pricing';

const pt = (quantity: number, unit_ttc: number, extra: Partial<CurvePoint> = {}): CurvePoint => ({
  quantity,
  unit_ht: unit_ttc / 1.13,
  unit_ttc,
  task_ttc: unit_ttc * quantity,
  multiplier: 1.3,
  qty_factor: 0.7,
  floor_applied: false,
  current: false,
  ...extra,
});

describe('CalculatorQuantityCurve', () => {
  it('renders one row per point with unit, task, factor and multiplier; flags current and floor', () => {
    render(
      <CalculatorQuantityCurve
        currency="USD"
        points={[pt(1, 13.56, { floor_applied: true }), pt(5, 8, { current: true, multiplier: 1.25, qty_factor: 0.55 }), pt(10, 7)]}
      />,
    );
    expect(screen.getByText('Price by quantity')).toBeInTheDocument();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('5')).toBeInTheDocument();
    expect(within(rows[1]).getByText('$8.00')).toBeInTheDocument();
    expect(within(rows[1]).getByText('$40.00')).toBeInTheDocument();
    expect(within(rows[1]).getByText('0.55')).toBeInTheDocument();
    expect(within(rows[1]).getByText('×1.25')).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(within(rows[0]).getByTitle('Minimum price applied')).toBeInTheDocument();
  });

  it('renders nothing for an empty curve', () => {
    const { container } = render(<CalculatorQuantityCurve currency="USD" points={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
