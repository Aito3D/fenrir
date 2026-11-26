import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SplitButton } from '../../../components/orders/SplitButton';

const setup = (items: Parameters<typeof SplitButton>[0]['items'], onClick = vi.fn()) => {
  render(<SplitButton label="Pay 100" menuLabel="Other options" onClick={onClick} items={items} />);
  return onClick;
};
const item = (o = {}) => ({ key: 'a', label: 'Create the order', onSelect: vi.fn(), ...o });

afterEach(() => vi.useRealTimers());

describe('SplitButton', () => {
  it('scrolls the menu into view when it opens', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      setup([item()]);
      await userEvent.click(screen.getByRole('button', { name: 'Other options' }));
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      // @ts-expect-error jsdom has none: restore that
      delete Element.prototype.scrollIntoView;
    }
  });

  it('the arrow opens the menu and an item runs', async () => {
    const user = userEvent.setup();
    const a = item();
    const onClick = setup([a]);
    const arrow = screen.getByRole('button', { name: 'Other options' });
    expect(arrow).toHaveAttribute('aria-expanded', 'false');
    await user.click(arrow);
    expect(arrow).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('menuitem', { name: 'Create the order' }));
    expect(a.onSelect).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('a 500 ms press on the main button opens the menu and does not click', () => {
    vi.useFakeTimers();
    const onClick = setup([item()]);
    const main = screen.getByRole('button', { name: 'Pay 100' });
    fireEvent.pointerDown(main);
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerUp(main);
    fireEvent.click(main);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.pointerDown(main);
    fireEvent.pointerUp(main);
    fireEvent.click(main);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('an item with a disabledReason shows the reason and does not run', async () => {
    const user = userEvent.setup();
    const a = item({ disabledReason: 'No email address for this customer' });
    setup([a]);
    await user.click(screen.getByRole('button', { name: 'Other options' }));
    const entry = screen.getByRole('menuitem', { name: 'Create the order' });
    expect(entry).toHaveAttribute('aria-disabled', 'true');
    await user.click(entry);
    expect(screen.getByRole('alert')).toHaveTextContent('No email address for this customer');
    expect(a.onSelect).not.toHaveBeenCalled();
  });

  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    setup([item()]);
    await user.click(screen.getByRole('button', { name: 'Other options' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('a click outside closes the menu', async () => {
    const user = userEvent.setup();
    setup([item()]);
    await user.click(screen.getByRole('button', { name: 'Other options' }));
    await user.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
