import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { TaskMiniRows } from '../../components/aito/TaskMiniRows';

const tasks = [
  { services: ['scan', 'modelisation', 'impression'], done: ['scan', 'modelisation'], title: 'Support principal' },
  { services: ['modelisation', 'impression'], done: [], title: '' },
];

describe('TaskMiniRows', () => {
  it('renders one row per task: title, segments, count', () => {
    render(<TaskMiniRows tasks={tasks} />);
    const rows = screen.getAllByTestId('aito-task-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Support principal');
    expect(rows[0]).toHaveTextContent('2/3');
  });

  it('falls back to the numbered task name for an untitled task', () => {
    render(<TaskMiniRows tasks={tasks} />);
    expect(screen.getAllByTestId('aito-task-row')[1]).toHaveTextContent('Task 2');
  });

  it('colours exactly the done segments with the stage colour', () => {
    render(<TaskMiniRows tasks={tasks} />);
    const segs = screen.getAllByTestId('aito-task-segment');
    expect(segs).toHaveLength(5);
    expect(segs[0].className).toContain('bg-teal-400');       // scan, done
    expect(segs[1].className).toContain('bg-violet-400');     // modelisation, done
    expect(segs[2].className).toContain('bg-bambu-dark-tertiary'); // impression, pending
  });

  it('states each row for assistive tech and hides the decoration', () => {
    render(<TaskMiniRows tasks={tasks} />);
    const row = screen.getAllByTestId('aito-task-row')[0];
    expect(row).toHaveAttribute('aria-label', expect.stringMatching(/Support principal.*2\/3/));
    expect(row.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders nothing for a project with no tasks', () => {
    // Not `container` — the shared render helper (`../utils`) always mounts
    // ToastProvider, whose viewport div is in every tree. Assert the rows
    // wrapper itself is absent instead.
    render(<TaskMiniRows tasks={[]} />);
    expect(screen.queryByTestId('aito-task-rows')).not.toBeInTheDocument();
  });
});
