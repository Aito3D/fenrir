import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Trash2 } from 'lucide-react';
import { render } from '../utils';
import { ViewToggleButton } from '../../components/aito/ViewToggleButton';

describe('ViewToggleButton', () => {
  it('iconOnly: is named by its label when inactive and "Back to board" when active, with no visible text', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ViewToggleButton iconOnly active={false} onToggle={onToggle} icon={Trash2} label="Trash" />);
    const btn = screen.getByRole('button', { name: 'Trash' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('title', 'Trash');
    expect(btn).not.toHaveTextContent('Trash');
    await userEvent.setup().click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<ViewToggleButton iconOnly active onToggle={onToggle} icon={Trash2} label="Trash" />);
    const back = screen.getByRole('button', { name: 'Back to board' });
    expect(back).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Trash' })).not.toBeInTheDocument();
  });

  it('with a text label: renders the label and swaps to "Back to board" when active', () => {
    const { rerender } = render(<ViewToggleButton active={false} onToggle={vi.fn()} icon={Trash2} label="Show done (3)" />);
    expect(screen.getByRole('button', { name: 'Show done (3)' })).toHaveTextContent('Show done (3)');
    rerender(<ViewToggleButton active onToggle={vi.fn()} icon={Trash2} label="Show done (3)" />);
    expect(screen.getByRole('button', { name: 'Back to board' })).toBeInTheDocument();
  });

  it('keeps both layers mounted and crossfades them (opacity + translate), so the width never changes', () => {
    const { rerender } = render(<ViewToggleButton active={false} onToggle={vi.fn()} icon={Trash2} label="Show done (3)" />);
    const [inactive, active] = Array.from(screen.getByRole('button').querySelectorAll('span.grid > span'));
    expect(inactive).toHaveClass('opacity-100', 'translate-x-0');
    expect(active).toHaveClass('opacity-0', 'translate-x-1', 'pointer-events-none');
    expect(active.className).toMatch(/transition-\[opacity,translate\]/);
    rerender(<ViewToggleButton active onToggle={vi.fn()} icon={Trash2} label="Show done (3)" />);
    expect(inactive).toHaveClass('opacity-0', '-translate-x-1');
    expect(active).toHaveClass('opacity-100', 'translate-x-0');
    // Still two layers: the hidden one is the strut that holds the width.
    expect(screen.getByRole('button').querySelectorAll('span.grid > span')).toHaveLength(2);
  });
});
