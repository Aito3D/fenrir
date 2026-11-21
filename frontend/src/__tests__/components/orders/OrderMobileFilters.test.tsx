import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { OrderBoardRow } from '../../../api/client';
import { OrderMobileFilters } from '../../../components/orders/OrderMobileFilters';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { days?: number }) => (o?.days !== undefined ? `${k}:${o.days}` : k) }),
}));

const row = (contacted?: string) => ({ contacted: contacted ? { at: contacted } : null }) as unknown as OrderBoardRow;
const DAY = 86_400_000;

function setup(over: Partial<Parameters<typeof OrderMobileFilters>[0]> = {}) {
  const onFollow = vi.fn();
  render(
    <OrderMobileFilters
      layout="sheet" coreOnly={false} hidden={0} onToggleCore={vi.fn()} pay="all"
      payCounts={{ all: 0, unpaid: 0, partial: 0, paid: 0, overdue: 0 } as never} showOverdue={false} onPay={vi.fn()}
      follow={null} followed={{ unbilled: [], notCollected: [] }} onFollow={onFollow}
      sort={{ key: 'age', flipped: false }} onSort={vi.fn()} {...over}
    />,
  );
  return onFollow;
}

describe('OrderMobileFilters follow-up chips', () => {
  it('shows the count and the longest wait of uncollected parcels, and picks the chip', () => {
    const at = new Date(Date.now() - 3 * DAY - 60_000).toISOString();
    const onFollow = setup({ followed: { unbilled: [], notCollected: [row(at), row()] } });
    const chip = screen.getByRole('button', { name: /aito.followups.notCollected/ });
    expect(chip).toHaveTextContent('2');
    expect(chip).toHaveTextContent('aito.followups.longest:3');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: /orders.follow.unbilled/ })).not.toBeInTheDocument();
    fireEvent.click(chip);
    expect(onFollow).toHaveBeenCalledWith('notCollected');
  });

  it('clears the filter when the active chip is clicked, and keeps an empty active chip visible', () => {
    const onFollow = setup({ follow: 'unbilled' });
    const chip = screen.getByRole('button', { name: /orders.follow.unbilled/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(onFollow).toHaveBeenCalledWith(null);
  });

  it('hides the follow-up group when nothing is followed and nothing is active', () => {
    setup();
    expect(screen.queryByRole('group', { name: 'aito.followups.title' })).not.toBeInTheDocument();
  });
});
