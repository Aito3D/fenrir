import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { BoardCardActions } from '../../components/aito/BoardCardActions';
import { makeProject } from '../fixtures/aitoProject';
import type { AitoProject } from '../../api/client';

function Harness({ project }: { project: AitoProject }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={ref}>
      <BoardCardActions project={project} cardRef={ref} />
    </div>
  );
}

describe('BoardCardActions', () => {
  it('offers Mark as sent on a Quote card', () => {
    render(<Harness project={makeProject({ column: 'devis' })} />);
    expect(screen.getByRole('button', { name: 'Mark as sent' })).toBeInTheDocument();
  });

  it('offers Accept on a Waiting card and not Mark as sent', () => {
    render(<Harness project={makeProject({ column: 'waiting', quote_status: 'sent' })} />);
    expect(screen.queryByRole('button', { name: 'Mark as sent' })).toBeNull();
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('renders nothing on a Scan card with no finishing step', () => {
    const { container } = render(<Harness project={makeProject({ column: 'scan' })} />);
    expect(container.querySelectorAll('button').length).toBe(0);
  });
});
