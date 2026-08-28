import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FormulaPopover } from '../../../components/calculator/FormulaPopover';

describe('FormulaPopover', () => {
  it('opens on click, lists the lines, closes on Escape and on outside click', async () => {
    const user = userEvent.setup();
    render(<div><span data-testid="outside">x</span><FormulaPopover label="Size margin formula" lines={['m(u) = …', '= 1.50 + 0.50 · 5000 / (u + 5000)']} /></div>);
    const btn = screen.getByRole('button', { name: 'Size margin formula' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await user.click(btn);
    expect(screen.getByRole('dialog', { name: 'Size margin formula' })).toHaveTextContent('= 1.50 + 0.50 · 5000 / (u + 5000)');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(btn);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
