import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarginBreakdown } from '../../../components/revenue/MarginBreakdown';
import type { RevenueBucket } from '../../../components/revenue/lib/types';

const bucket = (costParts: RevenueBucket['costParts']) => ({ costedHt: 1000, cost: 300, costParts }) as RevenueBucket;

describe('MarginBreakdown', () => {
  it('gives the estimated fixed costs their own marked line, after the real ones', () => {
    render(<MarginBreakdown bucket={bucket({ items: 0, fixed: 200, fixedEstimated: 100 })} />);
    const lines = [...screen.getByRole('group').querySelectorAll('p')].map((p) => p.textContent);
    expect(lines).toEqual(['Costed revenue HT1.000 FCP', 'Fixed costs−200 FCP', 'Fixed costs (estimated)≈ −100 FCP', 'Gross margin HT700 FCP']);
  });

  it('shows no estimate line without an estimate', () => {
    render(<MarginBreakdown bucket={bucket({ items: 0, fixed: 200 })} />);
    expect(screen.queryByText(/estimated/)).toBeNull();
  });
});
