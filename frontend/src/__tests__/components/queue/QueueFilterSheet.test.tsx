import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { QueueFilterSheet } from '../../../components/queue/mobile/QueueFilterSheet';
import { hasActiveQueueFilter } from '../../../components/queue/mobile/queueFilters';

function props(overrides: Partial<React.ComponentProps<typeof QueueFilterSheet>> = {}) {
  return {
    printers: [{ id: 1, name: 'X1C' }, { id: 2, name: 'P1S' }],
    filterPrinter: null,
    onFilterPrinter: vi.fn(),
    filterStatus: '',
    onFilterStatus: vi.fn(),
    locations: ['Shop', 'Garage'],
    filterLocation: '',
    onFilterLocation: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('QueueFilterSheet', () => {
  it('lists printers with Unassigned and picks one', async () => {
    const p = props();
    render(<QueueFilterSheet {...p} />);
    const printer = screen.getByRole('group', { name: 'Printer' });
    await userEvent.click(within(printer).getByRole('button', { name: 'Unassigned' }));
    expect(p.onFilterPrinter).toHaveBeenCalledWith(-1);
    await userEvent.click(within(printer).getByRole('button', { name: 'P1S' }));
    expect(p.onFilterPrinter).toHaveBeenCalledWith(2);
  });

  it('marks the active status and location, resets all three', async () => {
    const p = props({ filterStatus: 'printing', filterLocation: 'Shop', filterPrinter: 1 });
    render(<QueueFilterSheet {...p} />);
    expect(screen.getByRole('button', { name: 'Printing', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shop', pressed: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(p.onFilterPrinter).toHaveBeenCalledWith(null);
    expect(p.onFilterStatus).toHaveBeenCalledWith('');
    expect(p.onFilterLocation).toHaveBeenCalledWith('');
  });

  it('hides Location without locations and shows View only when given', () => {
    const { unmount } = render(<QueueFilterSheet {...props({ locations: [] })} />);
    expect(screen.queryByRole('group', { name: 'Location' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'View' })).not.toBeInTheDocument();
    unmount();
    const onLayout = vi.fn();
    const onSjf = vi.fn();
    render(<QueueFilterSheet {...props({ view: { layout: 'position', onLayout, sjf: false, onSjf } })} />);
    const view = screen.getByRole('group', { name: 'View' });
    expect(within(view).getByRole('button', { name: 'By Printer' })).toBeInTheDocument();
  });

  it('View: layout segments and the SJF switch call back', async () => {
    const onLayout = vi.fn();
    const onSjf = vi.fn();
    render(<QueueFilterSheet {...props({ view: { layout: 'position', onLayout, sjf: false, onSjf } })} />);
    await userEvent.click(screen.getByRole('button', { name: 'By Printer' }));
    expect(onLayout).toHaveBeenCalledWith('printer');
    await userEvent.click(screen.getByRole('switch', { name: /SJF/ }));
    expect(onSjf).toHaveBeenCalledWith(true);
  });

  it('hasActiveQueueFilter counts Unassigned as a filter', () => {
    expect(hasActiveQueueFilter(null, '', '')).toBe(false);
    expect(hasActiveQueueFilter(-1, '', '')).toBe(true);
    expect(hasActiveQueueFilter(null, 'failed', '')).toBe(true);
    expect(hasActiveQueueFilter(null, '', 'Shop')).toBe(true);
  });
});
