/** A sub-project row's status chip is the page's StatusBadge: its colour and its translated label. */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../../utils';
import { SubProjectsPanel } from '../../../../components/projects/detail/SubProjectsPanel';
import type { ProjectChildPreview } from '../../../../api/client';

const child = (id: number, status: string): ProjectChildPreview => ({
  id,
  name: `Child ${id}`,
  color: null,
  status,
  progress_percent: null,
  descendant_count: 0,
  total_archives: 0,
  completed_prints: 0,
  total_print_time_hours: 0,
  total_filament_grams: 0,
  total_cost: 0,
});

describe('SubProjectsPanel status chip', () => {
  it.each([
    ['active', 'Active', 'bg-bambu-green/20'],
    ['completed', 'Completed', 'text-blue-700'],
    ['archived', 'Archived', 'bg-bambu-gray/20'],
  ])('renders %s with the StatusBadge colour and label', (status, label, colour) => {
    render(<SubProjectsPanel subProjects={[child(1, status)]} currency="$" />);
    const chip = screen.getByText(label);
    expect(chip.className).toContain(colour);
    expect(chip.className).toContain('rounded-full');
    expect(screen.queryByText(status)).not.toBeInTheDocument();
  });
});
