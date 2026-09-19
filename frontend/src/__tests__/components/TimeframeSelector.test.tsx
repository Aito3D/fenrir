import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TimeframeSelector } from '../../components/stats/TimeframeSelector';
import { useTimeframe } from '../../components/stats/timeframe';

function Harness() {
  const { timeframe, setTimeframe, range } = useTimeframe('test-timeframe', 'last-30');
  return (
    <div>
      <TimeframeSelector timeframe={timeframe} onChange={setTimeframe} />
      <output data-testid="range">{range.dateFrom ?? 'none'}</output>
    </div>
  );
}

describe('TimeframeSelector', () => {
  beforeEach(() => localStorage.clear());

  it('opens on the default preset and switches to another one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Last 30 Days/ })).toBeInTheDocument();
    expect(screen.getByTestId('range')).not.toHaveTextContent('none');
    await user.click(screen.getByRole('button', { name: /Last 30 Days/ }));
    await user.click(screen.getByRole('button', { name: 'All Time' }));
    expect(screen.getByRole('button', { name: /All Time/ })).toBeInTheDocument();
    expect(screen.getByTestId('range')).toHaveTextContent('none');
    expect(JSON.parse(localStorage.getItem('test-timeframe')!).preset).toBe('all-time');
  });

  it('restores a persisted preset', () => {
    localStorage.setItem('test-timeframe', JSON.stringify({ preset: 'last-7' }));
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Last 7 Days/ })).toBeInTheDocument();
  });

  it('keeps the menu mounted and toggles `hidden`, so it can animate in and out', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const menu = document.querySelector('.aito-tf-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.hidden).toBe(true);
    await user.click(screen.getByRole('button', { name: /Last 30 Days/ }));
    expect(menu.hidden).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Last 7 Days' }));
    expect(menu.hidden).toBe(true);
    expect(screen.getByRole('button', { name: /Last 7 Days/ })).toBeInTheDocument();
  });
});
