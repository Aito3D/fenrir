import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from '../../../components/filament-trees/Dialog';

describe('filament-trees Dialog close animation', () => {
  it('ignores footer clicks once closing has started', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <Dialog title="T" onClose={vi.fn()} footer={<button onClick={onConfirm}>Confirm</button>}>
        body
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    // inert also blocks keyboard activation in browsers (jsdom does not enforce it, so assert the attribute)
    expect(dialog).toHaveAttribute('inert');
    await expect(user.click(screen.getByRole('button', { name: 'Confirm' }))).rejects.toThrow(/pointer-events: none/);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
