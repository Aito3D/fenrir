import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { MobileColumnSheet } from '../../components/aito/MobileColumnSheet';
import { COLUMNS } from '../../components/aito/columns';
import type { ColumnSummary } from '../../utils/aitoMobileBoard';

const summaries: ColumnSummary[] = COLUMNS.map((column, i) => ({ column, count: i, oldestDays: i ? i * 2 : null, oldestCls: '' }));

function setup(onPick = vi.fn(), onClose = vi.fn()) {
  render(<MobileColumnSheet columns={summaries} current={2} pending={false} heading={<span>Aito 52</span>} onPick={onPick} onClose={onClose} />);
  return { onPick, onClose };
}

describe('MobileColumnSheet', () => {
  it('is a labelled modal dialog that takes focus and lists every column', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Columns' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveFocus();
    expect(screen.getByText('Aito 52')).toBeInTheDocument();
    expect(screen.getAllByRole('button').filter((b) => b.dataset.column)).toHaveLength(6);
    expect(screen.getByRole('button', { name: /Scan/ })).toHaveAttribute('aria-current', 'true');
  });

  it('picks a column and closes', async () => {
    const user = userEvent.setup();
    const { onPick, onClose } = setup();
    await user.click(screen.getByRole('button', { name: /Printing/ }));
    expect(onPick).toHaveBeenCalledWith(4);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  // One close per mount: in the page the sheet unmounts on its first close.
  it('closes on the scrim', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByTestId('aito-mobile-sheet-scrim'));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('closes on Escape', async () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  // jsdom has no PointerEvent; a MouseEvent typed `pointerdown` carries the
  // clientY React's onPointerDown reads.
  const pointer = (type: string, clientY: number) => new MouseEvent(type, { bubbles: true, clientY });

  it('closes on a downward swipe', async () => {
    const { onClose } = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, pointer('pointerdown', 400));
    fireEvent(dialog, pointer('pointerup', 480));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('owns vertical touch gestures so the browser never cancels the swipe into a pan', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveClass('touch-none');
  });

  it('a cancelled pointer does not leave a stale start for the next release', async () => {
    const { onClose } = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, pointer('pointerdown', 400));
    fireEvent(dialog, pointer('pointercancel', 400));
    fireEvent(dialog, pointer('pointerup', 480));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on a tap (no travel)', async () => {
    const { onClose } = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, pointer('pointerdown', 400));
    fireEvent(dialog, pointer('pointerup', 405));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(onClose).not.toHaveBeenCalled();
  });
});
