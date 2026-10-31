/** A sub-project row's status chip is the page's StatusBadge: its colour and its translated label. */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
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

describe('SubProjectsPanel row', () => {
  const wing: ProjectChildPreview = {
    ...child(2, 'active'),
    name: 'Wing',
    descendant_count: 1,
    total_archives: 4,
    total_filament_grams: 250,
    total_cost: 12.5,
    progress_percent: 50,
  };
  const bare: ProjectChildPreview = { ...child(3, 'active'), name: 'Bare' };

  it('links each row to its project and shows its branch figures', () => {
    render(<SubProjectsPanel subProjects={[wing, bare]} currency="$" />);
    expect(screen.getByText('Sub-projects (2)')).toBeInTheDocument();
    const row = screen.getByRole('link', { name: /Wing/ });
    expect(row).toHaveAttribute('href', '/projects/2');
    const inRow = within(row);
    expect(inRow.getByText('Wing')).toBeInTheDocument();
    expect(inRow.getByText('Active')).toBeInTheDocument();
    expect(inRow.getByText('1')).toBeInTheDocument();
    expect(inRow.getByText('4 jobs')).toBeInTheDocument();
    expect(inRow.getByText('250g')).toBeInTheDocument();
    expect(inRow.getByText('$12.50')).toBeInTheDocument();
    expect(inRow.getByText('50%')).toBeInTheDocument();
  });

  it('hides the descendant count, jobs, filament, cost and progress when they are zero or null', () => {
    render(<SubProjectsPanel subProjects={[wing, bare]} currency="$" />);
    const row = screen.getByRole('link', { name: /Bare/ });
    expect(row).toHaveAttribute('href', '/projects/3');
    expect(row.textContent).toBe('BareActive');
  });

  it('capitalises an unknown status and gives it the active colour', () => {
    render(<SubProjectsPanel subProjects={[child(4, 'paused')]} currency="$" />);
    const chip = screen.getByText('Paused');
    expect(chip.className).toContain('bg-bambu-green/20');
    expect(screen.queryByText('paused')).not.toBeInTheDocument();
  });
});
