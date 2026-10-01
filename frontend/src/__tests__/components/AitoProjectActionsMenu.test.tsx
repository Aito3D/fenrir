import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ProjectActionsMenu } from '../../components/aito/ProjectActionsMenu';

describe('ProjectActionsMenu', () => {
  it('is a ⋯ button that opens a menu whose Merge item fires onMerge and closes', async () => {
    const user = userEvent.setup();
    const onMerge = vi.fn();
    render(<ProjectActionsMenu onMerge={onMerge} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'More actions' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(screen.getByRole('menu', { name: 'More actions' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('menuitem', { name: 'Merge another card…' }));
    expect(onMerge).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
