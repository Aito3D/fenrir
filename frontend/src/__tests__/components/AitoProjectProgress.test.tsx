import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectProgress } from '../../components/aito/ProjectProgress';

describe('ProjectProgress', () => {
  it('renders nothing when the project has no steps', () => {
    const { container } = render(<ProjectProgress done={0} total={0} />);
    // An unpriced project has nothing to measure; an empty bar on every fresh
    // card would be clutter, not information.
    expect(container).toBeEmptyDOMElement();
  });

  it('reports the ratio to assistive technology', () => {
    render(<ProjectProgress done={3} total={10} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '3');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '10');
  });

  it('sets the fill width to the completed fraction', () => {
    render(<ProjectProgress done={3} total={10} />);
    const fill = screen.getByTestId('aito-progress-fill');
    expect(fill).toHaveStyle({ width: '30%' });
  });

  it('fills completely when every step is done', () => {
    render(<ProjectProgress done={4} total={4} />);
    expect(screen.getByTestId('aito-progress-fill')).toHaveStyle({ width: '100%' });
  });

  it('counts a free step like any other', () => {
    // The caller counts steps, not money — a step quoted 0 is a real step, so
    // 1 of 2 is 50% regardless of price. This asserts the component does no
    // cost arithmetic of its own.
    render(<ProjectProgress done={1} total={2} />);
    expect(screen.getByTestId('aito-progress-fill')).toHaveStyle({ width: '50%' });
  });
});
