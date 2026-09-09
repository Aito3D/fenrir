import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../utils';
import { DatePicker } from '../../components/aito/DatePicker';
import { weekStartFor } from '../../utils/date';

// Tuesday 8 September 2026 throughout: the month has a leading partial week
// (Sunday-first, the grid opens on Aug 30) so every "other month" and
// "cross a month edge" branch is reachable from a fixed calendar.
const TODAY = '2026-09-08';

function mount(props: Partial<React.ComponentProps<typeof DatePicker>> = {}) {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(
    <DatePicker value={null} today={TODAY} label="Promised date" onChange={onChange} onClose={onClose} {...props} />,
  );
  return { onChange, onClose };
}
const cell = (name: string | RegExp) => screen.getByRole('gridcell', { name });
const title = () => screen.getByTitle(/back to the selected month/i);

describe('weekStartFor', () => {
  it('starts an English week on Sunday and every other shipped language on Monday', () => {
    expect(weekStartFor('en-US')).toBe(0);
    expect(weekStartFor('fr')).toBe(1);
    expect(weekStartFor('de')).toBe(1);
  });
});

describe('DatePicker', () => {
  it('opens on the selected month, with the selection filled and today dotted', () => {
    mount({ value: '2026-09-20' });
    expect(title()).toHaveTextContent('September 2026');
    expect(cell('Sep 20, 2026')).toHaveAttribute('aria-selected', 'true');
    expect(cell('Sep 20, 2026')).toHaveClass('bg-bambu-green');
    expect(cell('Sep 8, 2026')).toHaveAttribute('aria-current', 'date');
    expect(cell('Sep 8, 2026')).toHaveClass('after:bg-bambu-green');
    // Selected and focused: the selection is where keyboard travel starts.
    expect(cell('Sep 20, 2026')).toHaveFocus();
  });

  it('lands on the suggestion when nothing is set, outlined but not selected', () => {
    // The suggestion is where the operator's promise probably goes, so it is
    // where focus starts — but it is a proposal, so it is a ring, not a fill,
    // and nothing is written until it is picked.
    const { onChange } = mount({ suggested: '2026-09-10' });
    const suggested = cell(/Sep 10, 2026 \(suggested\)/);
    expect(suggested).toHaveFocus();
    expect(suggested).toHaveAttribute('aria-selected', 'false');
    expect(suggested).toHaveClass('ring-1');
    expect(suggested).not.toHaveClass('bg-bambu-green');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lays the grid out from the locale week start: Sunday first in English', () => {
    mount();
    // Sep 1, 2026 is a Tuesday, so a Sunday-first grid leads with Aug 30.
    const cells = screen.getAllByRole('gridcell');
    expect(cells).toHaveLength(42);
    expect(cells[0]).toHaveAccessibleName('Aug 30, 2026');
    // Six rows always: the grid runs to Oct 10 so the footer never jumps.
    expect(cells[41]).toHaveAccessibleName('Oct 10, 2026');
  });

  it('marks a day of the neighbouring month as such, unless it is past — past wins', () => {
    mount();
    expect(cell('Oct 3, 2026')).toHaveClass('text-bambu-gray-dark');
    expect(cell('Aug 30, 2026')).toHaveClass('text-bambu-gray');
    expect(cell('Aug 30, 2026')).not.toHaveClass('text-bambu-gray-dark');
  });

  it('recedes the past and keeps the future white', () => {
    mount();
    expect(cell('Sep 3, 2026')).toHaveClass('text-bambu-gray');
    expect(cell('Sep 12, 2026')).toHaveClass('text-white');
  });

  it('picks a day and closes', () => {
    const { onChange, onClose } = mount();
    fireEvent.click(cell('Sep 12, 2026'));
    expect(onChange).toHaveBeenCalledWith('2026-09-12');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('offers two working days, one week and two weeks as one-click promises', () => {
    // No Today chip: a job accepted now is never finished today, and today
    // is already one click away under its dot in the grid.
    const { onChange } = mount();
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+2 days' }));
    fireEvent.click(screen.getByRole('button', { name: '+1 week' }));
    fireEvent.click(screen.getByRole('button', { name: '+2 weeks' }));
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['2026-09-10', '2026-09-15', '2026-09-22']);
  });

  it('counts the +2 days chip in working days, so a Friday promises Tuesday', () => {
    const { onChange } = mount({ today: '2026-09-11' }); // a Friday
    const chip = screen.getByRole('button', { name: '+2 days' });
    // The tooltip says where the chip lands, since "+2 days" alone would
    // read as Sunday.
    expect(chip).toHaveAttribute('title', 'Sep 15, 2026');
    fireEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith('2026-09-15');
  });

  it('turns the page in the direction of travel, and not on open', () => {
    // The grid remounts per month with a slide from the side the month came
    // from; the first paint leaves motion to the popover's own pop-in.
    mount({ value: '2026-09-20' });
    const grid = () => screen.getByRole('grid');
    expect(grid()).not.toHaveClass('animate-aito-page-next');
    expect(grid()).not.toHaveClass('animate-aito-page-prev');
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'PageDown' });
    expect(grid()).toHaveClass('animate-aito-page-next');
    fireEvent.click(screen.getByRole('button', { name: /previous month/i }));
    expect(grid()).toHaveClass('animate-aito-page-prev');
    // A move that stays inside the month leaves the page where it is.
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(grid()).toHaveClass('animate-aito-page-prev');
    // Home from two months out is a backward turn, however far.
    fireEvent.keyDown(dialog, { key: 'PageDown' });
    fireEvent.keyDown(dialog, { key: 'PageDown' });
    fireEvent.click(title());
    expect(grid()).toHaveClass('animate-aito-page-prev');
  });

  it('shows Clear only once there is something to clear, and clears with null', () => {
    const first = mount();
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    expect(first.onChange).not.toHaveBeenCalled();
    const { onChange, onClose } = mount({ value: '2026-09-20' });
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });

  it('moves focus by day and by week, and follows it across a month edge', () => {
    mount({ suggested: '2026-09-10' });
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(cell('Sep 11, 2026')).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    expect(cell('Sep 18, 2026')).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    // Sep 4 → Aug 28: the view turns the page with the focus.
    expect(cell('Aug 28, 2026')).toHaveFocus();
    expect(title()).toHaveTextContent('August 2026');
  });

  it('turns pages with PageUp/PageDown and the chevrons, and the title comes home', () => {
    mount({ value: '2026-09-20' });
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'PageDown' });
    expect(title()).toHaveTextContent('October 2026');
    expect(cell('Oct 20, 2026')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    expect(title()).toHaveTextContent('November 2026');
    fireEvent.click(screen.getByRole('button', { name: /previous month/i }));
    fireEvent.keyDown(dialog, { key: 'PageUp' });
    expect(title()).toHaveTextContent('September 2026');
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    fireEvent.click(title());
    expect(title()).toHaveTextContent('September 2026');
    expect(cell('Sep 20, 2026')).toHaveFocus();
  });

  it('clamps a month jump to the shorter month rather than overflowing into the next', () => {
    mount({ value: '2026-10-31' });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'PageDown' });
    expect(cell('Nov 30, 2026')).toHaveFocus();
  });

  it('jumps to the edges of the week with Home and End', () => {
    mount({ suggested: '2026-09-10' }); // a Thursday
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Home' });
    expect(cell('Sep 6, 2026')).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'End' });
    expect(cell('Sep 12, 2026')).toHaveFocus();
  });

  it('closes on Escape without changing anything', () => {
    const { onChange, onClose } = mount();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
