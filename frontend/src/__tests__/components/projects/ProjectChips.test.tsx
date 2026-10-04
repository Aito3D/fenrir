import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { ProjectCodeChip } from '../../../components/projects/ProjectCodeChip';
import { ProjectTagChips } from '../../../components/projects/ProjectTagChips';

describe('ProjectCodeChip', () => {
  it('renders the code', () => {
    render(<ProjectCodeChip code="P-0042" />);
    expect(screen.getByText('P-0042')).toBeInTheDocument();
  });

  it('renders nothing without a code', () => {
    // The render wrapper mounts a toast viewport, so assert on the chip's own output.
    render(<ProjectCodeChip code={null} className="chip-under-test" />);
    expect(document.querySelector('.chip-under-test')).toBeNull();
    expect(screen.queryByTitle(/P-/)).not.toBeInTheDocument();
  });
});

describe('ProjectTagChips', () => {
  it('lists tags and removes by index', async () => {
    const onRemove = vi.fn();
    render(<ProjectTagChips tags={[{ id: 1, name: 'drone' }, { id: null, name: 'neuf' }]} onRemove={onRemove} />);
    expect(screen.getByText('drone')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /neuf/ }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('has no remove buttons when read-only', () => {
    render(<ProjectTagChips tags={[{ id: 1, name: 'drone' }]} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
