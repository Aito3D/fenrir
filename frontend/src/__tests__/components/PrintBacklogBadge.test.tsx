import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { PrintBacklogBadge } from '../../components/aito/PrintBacklogBadge';

describe('PrintBacklogBadge', () => {
  it('renders nothing at zero minutes', () => {
    render(<PrintBacklogBadge minutes={0} printerCount={2} dailyHours={[8]} />);
    expect(screen.queryByTestId('aito-print-backlog')).not.toBeInTheDocument();
  });
  it('shows hours and days with the formula in the tooltip', () => {
    render(<PrintBacklogBadge minutes={2280} printerCount={3} dailyHours={[8]} />);
    const badge = screen.getByTestId('aito-print-backlog');
    expect(badge).toHaveTextContent('38 h to print');
    expect(badge).toHaveTextContent('≈ 1.6 d on 3 printers');
    expect(badge).toHaveAttribute('title', expect.stringContaining('38 h ÷ (3 × 8 h)'));
  });
  it('uses the singular for one printer', () => {
    render(<PrintBacklogBadge minutes={480} printerCount={1} dailyHours={[8]} />);
    expect(screen.getByTestId('aito-print-backlog')).toHaveTextContent('≈ 1.0 d on 1 printer');
  });
  it('shows hours only when the printer count is unknown, with no fabricated capacity', () => {
    render(<PrintBacklogBadge minutes={2280} dailyHours={[8]} />);
    const badge = screen.getByTestId('aito-print-backlog');
    expect(badge).toHaveTextContent('38 h to print');
    expect(badge).not.toHaveTextContent('≈');
    expect(badge.getAttribute('title')).not.toContain('÷');
  });
  it('formats the per-printer hours to one decimal when the mean is not integral', () => {
    render(<PrintBacklogBadge minutes={2280} printerCount={2} dailyHours={[8, 9]} />);
    const badge = screen.getByTestId('aito-print-backlog');
    expect(badge).toHaveAttribute('title', expect.stringContaining('38 h ÷ (2 × 8.5 h)'));
  });
  it('shows "< 0.1" instead of a rounded-to-zero days figure for tiny backlogs', () => {
    render(<PrintBacklogBadge minutes={20} printerCount={3} dailyHours={[8]} />);
    expect(screen.getByTestId('aito-print-backlog')).toHaveTextContent('≈ < 0.1 d on 3 printers');
  });
});
