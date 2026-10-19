/**
 * ProjectDetailPage: error / not-found states, the optional cards (progress,
 * cost, queue, sub-projects, prints grid), and the notes, export and
 * template actions with their success and failure toasts.
 */

/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ProjectDetailPage } from '../../pages/ProjectDetailPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const navigateMock = vi.fn();

// The export test stubs these with defineProperty, which vi.restoreAllMocks() does not undo.
const originalUrlDescriptors = {
  createObjectURL: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
  revokeObjectURL: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
};

function restoreUrlDescriptors() {
  for (const [key, descriptor] of Object.entries(originalUrlDescriptors)) {
    if (descriptor) Object.defineProperty(URL, key, descriptor);
    else delete (URL as unknown as Record<string, unknown>)[key];
  }
}

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: '1' }),
    useNavigate: () => navigateMock,
  };
});

const baseProject = {
  id: 1,
  name: 'Test Project',
  description: 'A test project',
  color: '#00ae42',
  status: 'active',
  priority: 'normal',
  due_date: null,
  notes: null,
  parent_id: null,
  budget: null,
  is_template: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const baseStats = {
  total_archives: 3,
  total_items: 3,
  completed_prints: 2,
  failed_prints: 1,
  queued_prints: 0,
  in_progress_prints: 0,
  total_print_time_hours: 2,
  total_filament_grams: 100,
  progress_percent: null,
  parts_progress_percent: null,
  estimated_cost: 5,
  total_energy_kwh: 0,
  total_energy_cost: 0,
  total_wear_cost: 0,
  remaining_prints: null,
  remaining_parts: null,
  bom_total_items: 0,
  bom_completed_items: 0,
  bom_cost: 0,
};

function useProject(project: Record<string, unknown>) {
  server.use(http.get('/api/v1/projects/:id', () => HttpResponse.json(project)));
}

describe('ProjectDetailPage actions and states', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    server.use(
      http.get('/api/v1/projects/:id/tree', () => HttpResponse.json({ project_id: 1, code: null, sections: [] })),
      http.get('/api/v1/projects/:id', () => HttpResponse.json(baseProject)),
      http.get('/api/v1/projects/:id/archives', () => HttpResponse.json([])),
      http.get('/api/v1/projects/:id/timeline', () => HttpResponse.json([])),
      http.get('/api/v1/library/folders/by-project/:id', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', () => HttpResponse.json([]))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(Object.getOwnPropertyDescriptor(URL, 'createObjectURL')).toEqual(originalUrlDescriptors.createObjectURL);
    expect(Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')).toEqual(originalUrlDescriptors.revokeObjectURL);
  });

  describe('load states', () => {
    it('shows the server error and a way back when the project fails to load', async () => {
      server.use(
        http.get('/api/v1/projects/:id', () => HttpResponse.json({ detail: 'Project not found' }, { status: 404 }))
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      expect(await screen.findByText(/Project not found/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back to Projects' }));
      expect(navigateMock).toHaveBeenCalledWith('/projects');
    });

    it('shows the empty-state copy for prints, timeline, notes and folders', async () => {
      render(<ProjectDetailPage />);

      expect(await screen.findByText('No prints in this project yet')).toBeInTheDocument();
      expect(screen.queryByText('Bill of Materials')).not.toBeInTheDocument();
      expect(screen.getByText('No activity yet.')).toBeInTheDocument();
      expect(screen.getByText(/No notes yet/)).toBeInTheDocument();
      // No linked folders: no panel, and the Details rail offers the File Manager instead.
      expect(screen.queryByTestId('project-linked-folders')).not.toBeInTheDocument();
      const details = screen.getByTestId('project-details');
      const link = within(details).getByRole('link', { name: 'Link folders from the File Manager' });
      expect(link).toHaveAttribute('href', '/files');
      expect(link).toHaveAttribute('title', expect.stringMatching(/No folders linked/));
      expect(within(details).getByText('Nothing queued')).toBeInTheDocument();
      expect(within(details).getByTestId('details-subprojects')).toHaveTextContent('—');
    });

    it('goes back to the projects list from the header arrow', async () => {
      const user = userEvent.setup();
      render(<ProjectDetailPage />);
      await screen.findByText('Notes');

      const arrow = screen.getAllByRole('button').find((b) => b.querySelector('svg.lucide-arrow-left'));
      expect(arrow).toBeDefined();
      await user.click(arrow!);
      expect(navigateMock).toHaveBeenCalledWith('/projects');
    });
  });

  describe('progress, cost, queue and meta cards', () => {
    it('renders plates, parts and sets progress with remaining counts', async () => {
      useProject({
        ...baseProject,
        target_count: 10,
        target_parts_count: 8,
        target_sets: 2,
        stats: { ...baseStats, progress_percent: 30, parts_progress_percent: 100, remaining_prints: 7, remaining_parts: 0 },
      });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('Plates Progress')).toBeInTheDocument();
      expect(screen.getByText('3 / 10 print jobs')).toBeInTheDocument();
      expect(screen.getByText('30% complete')).toBeInTheDocument();
      expect(screen.getByText('7 remaining')).toBeInTheDocument();
      // Parts progress lives in the Prints KPI tile.
      const prints = screen.getByTestId('kpi-prints');
      expect(prints).toHaveTextContent('2 / 8 parts');
      expect(prints).toHaveTextContent('100% complete');
      expect(prints).toHaveTextContent('3 print jobs');
      expect(prints).toHaveTextContent('1 failed');
      expect(screen.getByText('Complete Sets')).toBeInTheDocument();
      expect(screen.getByText('0 / 2 sets')).toBeInTheDocument();
    });

    it('shows cost, energy, wear, total and the remaining budget, leaving any BOM cost out', async () => {
      useProject({
        ...baseProject,
        budget: 100,
        stats: {
          ...baseStats,
          estimated_cost: 20,
          total_energy_kwh: 1.5,
          total_energy_cost: 0.5,
          total_wear_cost: 2,
          bom_cost: 10,
        },
      });
      render(<ProjectDetailPage />);

      const tile = await screen.findByTestId('kpi-cost');
      expect(within(tile).getByText('Estimated Cost')).toBeInTheDocument();
      expect(within(tile).getByText('$20.00')).toBeInTheDocument();
      expect(screen.getByText(/1\.500 kWh/)).toBeInTheDocument();
      expect(screen.getByText('($0.50)')).toBeInTheDocument();
      expect(screen.getByText('Printer Wear')).toBeInTheDocument();
      // Total = filament + energy + wear; the BOM cost stays out.
      expect(within(tile).getByTestId('kpi-cost-total')).toHaveTextContent('$22.50');
      expect(within(tile).getByTestId('kpi-cost-total')).toHaveClass('text-bambu-green');
      expect(screen.queryByText('incl. BOM')).not.toBeInTheDocument();
      expect(within(tile).getByText('$100.00')).toBeInTheDocument();
      const remaining = within(tile).getByTestId('kpi-cost-remaining');
      expect(remaining).toHaveTextContent('Remaining: $77.50');
      expect(remaining).toHaveClass('text-bambu-green');
      expect(remaining).not.toHaveTextContent('Over budget');
    });

    it('flags an exceeded budget in red with a negative remainder', async () => {
      useProject({ ...baseProject, budget: 3, stats: { ...baseStats, estimated_cost: 5 } });
      render(<ProjectDetailPage />);

      const tile = await screen.findByTestId('kpi-cost');
      expect(within(tile).getByTestId('kpi-cost-total')).toHaveTextContent('$5.00');
      expect(within(tile).getByTestId('kpi-cost-total')).toHaveClass('text-red-700');
      const remaining = within(tile).getByTestId('kpi-cost-remaining');
      expect(within(remaining).getByText('$-2.00')).toBeInTheDocument();
      expect(remaining).toHaveTextContent('Over budget');
      expect(remaining).toHaveClass('text-red-700');
    });

    it('shows the cost tile without a budget line when no budget is set', async () => {
      useProject({ ...baseProject, stats: { ...baseStats, estimated_cost: 5 } });
      render(<ProjectDetailPage />);

      const tile = await screen.findByTestId('kpi-cost');
      expect(within(tile).getByTestId('kpi-cost-total')).toHaveTextContent('$5.00');
      expect(within(tile).queryByTestId('kpi-cost-remaining')).not.toBeInTheDocument();
    });

    it('shows urgent priority and an overdue due date', async () => {
      useProject({ ...baseProject, priority: 'urgent', due_date: '2020-01-01T00:00:00Z', stats: baseStats });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('Urgent')).toBeInTheDocument();
      expect(screen.getByTestId('project-due')).toHaveTextContent('Overdue');
      expect(screen.getByText('Overdue')).toHaveClass('text-red-700');
    });

    it('shows days left for a due date a few days out', async () => {
      const due = new Date(Date.now() + 2.5 * 24 * 3600 * 1000).toISOString();
      useProject({ ...baseProject, priority: 'high', due_date: due, stats: baseStats });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('High')).toBeInTheDocument();
      expect(screen.getByText('3 days left')).toBeInTheDocument();
    });

    it('summarises the queue in the Details rail with a link to the project queue', async () => {
      useProject({
        ...baseProject,
        parent_id: 9,
        parent_name: 'Programme',
        stats: { ...baseStats, queued_prints: 2, in_progress_prints: 1 },
      });
      render(<ProjectDetailPage />);

      const details = await screen.findByTestId('project-details');
      expect(within(details).getByText('1 printing')).toBeInTheDocument();
      expect(within(details).getByText('2 queued')).toBeInTheDocument();
      expect(within(details).getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/queue?project=1');
      expect(within(details).getByRole('link', { name: 'Programme' })).toHaveAttribute('href', '/projects/9');
      // The print-time tile repeats what is printing right now.
      expect(within(screen.getByTestId('kpi-time')).getByText('1 printing')).toBeInTheDocument();
      // The rail comes after the main column (single column below xl).
      const main = screen.getByTestId('project-main');
      const rail = screen.getByTestId('project-rail');
      expect(main.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('holds the save-as-template action in the Details panel', async () => {
      render(<ProjectDetailPage />);

      const details = await screen.findByTestId('project-details');
      expect(within(details).getByRole('button', { name: /Save as Template/ })).toBeInTheDocument();
      expect(within(screen.getByTestId('project-main')).queryByRole('button', { name: /Save as Template/ })).toBeNull();
    });

    it('colours sub-project rows by status', async () => {
      useProject({
        ...baseProject,
        stats: baseStats,
        descendant_count: 0,
        rollup_stats: null,
        children: ['completed', 'archived', 'active'].map((status, i) => ({
          id: 10 + i,
          name: `Child ${status}`,
          color: null,
          status,
          progress_percent: null,
          descendant_count: 0,
          total_archives: 0,
          completed_prints: 0,
          total_print_time_hours: 0,
          total_filament_grams: 0,
          total_cost: 0,
        })),
      });
      render(<ProjectDetailPage />);

      const row = (await screen.findByText('Child completed')).closest('a');
      expect(row).toHaveAttribute('href', '/projects/10');
      expect(within(row as HTMLElement).getByText('completed')).toHaveClass('text-status-ok');
      expect(screen.getByTestId('details-subprojects')).toHaveTextContent('3');
      expect(screen.getByText('archived')).toHaveClass('text-bambu-gray');
      expect(screen.getByText('active')).toHaveClass('text-blue-700');
    });
  });

  describe('prints grid and timeline', () => {
    it('renders each archive tile with status overlay, link and revision caption', async () => {
      server.use(
        http.get('/api/v1/projects/:id/archives', () =>
          HttpResponse.json([
            { id: 1, print_name: 'Benchy', status: 'completed', thumbnail_path: 'a/t.png', revision_label: 'Support R2', order_id: 42 },
            { id: 2, print_name: null, status: 'failed', thumbnail_path: null, revision_label: null, order_id: null },
          ])
        )
      );
      render(<ProjectDetailPage />);

      expect(await screen.findByText('Prints (2)')).toBeInTheDocument();
      expect(screen.getByAltText('Benchy')).toBeInTheDocument();
      expect(screen.getByTestId('archive-revision-1').textContent).toContain('Support R2');
      expect(screen.getByTestId('archive-revision-1').textContent).toContain('42');
      const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href')?.startsWith('/archives?search='));
      expect(links.map((l) => l.getAttribute('href'))).toEqual(['/archives?search=Benchy', '/archives?search=']);
      expect(screen.queryByTestId('archive-revision-2')).not.toBeInTheDocument();
    });

    it('lists timeline events with their description', async () => {
      server.use(
        http.get('/api/v1/projects/:id/timeline', () =>
          HttpResponse.json([
            { event_type: 'print_completed', title: 'Print done', description: 'Benchy on X1C', timestamp: '2024-01-02T10:00:00Z' },
            { event_type: 'print_failed', title: 'Print failed', description: null, timestamp: '2024-01-03T10:00:00Z' },
            { event_type: 'queued', title: 'Queued a plate', description: null, timestamp: '2024-01-04T10:00:00Z' },
          ])
        )
      );
      render(<ProjectDetailPage />);

      expect(await screen.findByText('Print done')).toBeInTheDocument();
      expect(screen.getByText('Benchy on X1C')).toBeInTheDocument();
      expect(screen.getByText('Print failed')).toBeInTheDocument();
      expect(screen.getByText('Queued a plate')).toBeInTheDocument();
    });

    it('groups the vertical activity rail under Today / Yesterday / Earlier, newest first', async () => {
      const now = new Date();
      const at = (daysBack: number, hours: number) =>
        new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, hours, 0, 0).toISOString();
      // Deliberately out of order: the rail sorts newest first itself.
      server.use(
        http.get('/api/v1/projects/:id/timeline', () =>
          HttpResponse.json([
            { event_type: 'project_created', title: 'Created long ago', description: 'by admin', timestamp: at(9, 12) },
            { event_type: 'print_failed', title: 'Failed yesterday', description: null, timestamp: at(1, 15) },
            { event_type: 'print_completed', title: 'Done today', description: 'Benchy', timestamp: at(0, 0) },
            { event_type: 'queued', title: 'Queued yesterday', description: null, timestamp: at(1, 18) },
          ])
        )
      );
      render(<ProjectDetailPage />);

      const rail = await screen.findByTestId('project-activity');
      await within(rail).findByText('Done today');
      const items = within(rail).getAllByRole('listitem').map((li) => li.textContent ?? '');
      expect(items.map((text) => text.replace(/\s+/g, ' '))).toEqual([
        'Today',
        expect.stringContaining('Done today'),
        'Yesterday',
        expect.stringContaining('Queued yesterday'),
        expect.stringContaining('Failed yesterday'),
        'Earlier',
        expect.stringContaining('Created long ago'),
      ]);
      // One header per day, and each event keeps its type's colour.
      expect(within(rail).getAllByTestId(/^activity-day-/).map((el) => el.dataset.testid)).toEqual([
        'activity-day-today',
        'activity-day-yesterday',
        'activity-day-earlier',
      ]);
      const failed = within(rail).getByText('Failed yesterday').closest('li')!;
      expect(failed.querySelector('.text-status-error')).not.toBeNull();
      expect(failed.querySelector('svg.lucide-circle-x, svg.lucide-x-circle')).not.toBeNull();
    });

    it('shows the first 10 events, then all 20 on demand', async () => {
      const base = Date.now();
      server.use(
        http.get('/api/v1/projects/:id/timeline', () =>
          HttpResponse.json(
            Array.from({ length: 20 }, (_, i) => ({
              event_type: 'print_completed',
              title: `Event ${i + 1}`,
              description: null,
              timestamp: new Date(base - i * 60_000).toISOString(),
            }))
          )
        )
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      const rail = await screen.findByTestId('project-activity');
      await within(rail).findByText('Event 1');
      expect(within(rail).getAllByTestId('activity-event')).toHaveLength(10);
      expect(within(rail).queryByText('Event 11')).toBeNull();
      await user.click(within(rail).getByRole('button', { name: 'Show all (20)' }));
      expect(within(rail).getAllByTestId('activity-event')).toHaveLength(20);
      await user.click(within(rail).getByRole('button', { name: 'Show less' }));
      expect(within(rail).getAllByTestId('activity-event')).toHaveLength(10);
    });
  });

  describe('notes', () => {
    it('renders sanitised notes html', async () => {
      useProject({ ...baseProject, notes: '<p>Hello <b>world</b></p><script>window.__x=1</script>' });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('world')).toBeInTheDocument();
      expect(document.querySelector('.prose script')).toBeNull();
    });

    it('opens the editor and cancels without saving', async () => {
      let patched = false;
      server.use(
        http.patch('/api/v1/projects/:id', () => {
          patched = true;
          return HttpResponse.json(baseProject);
        })
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await screen.findByText(/No notes yet/);
      const notesCard = screen.getByRole('region', { name: 'Notes' });
      await user.click(within(notesCard).getByRole('button', { name: 'Edit' }));
      expect(screen.queryByText(/No notes yet/)).not.toBeInTheDocument();
      await user.click(within(notesCard).getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByText(/No notes yet/)).toBeInTheDocument();
      expect(patched).toBe(false);
    });

    it('saves notes and toasts, or shows the server error and stays in the editor', async () => {
      const bodies: Record<string, unknown>[] = [];
      let fail = true;
      server.use(
        http.patch('/api/v1/projects/:id', async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return fail
            ? HttpResponse.json({ detail: 'Notes too long' }, { status: 422 })
            : HttpResponse.json(baseProject);
        })
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await screen.findByText(/No notes yet/);
      const notesCard = screen.getByRole('region', { name: 'Notes' });
      await user.click(within(notesCard).getByRole('button', { name: 'Edit' }));
      await user.click(within(notesCard).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Notes too long')).toBeInTheDocument();
      expect(within(notesCard).getByRole('button', { name: 'Save' })).toBeInTheDocument();

      fail = false;
      await user.click(within(notesCard).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Project updated')).toBeInTheDocument();
      expect(bodies).toHaveLength(2);
      expect(bodies[1]).toHaveProperty('notes');
      await waitFor(() => expect(within(notesCard).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
    });
  });

  describe('export and template', () => {
    it('downloads the project zip using the server filename and toasts', async () => {
      server.use(
        http.get(
          '/api/v1/projects/:id/export',
          () =>
            new HttpResponse('zipbytes', {
              headers: { 'Content-Disposition': 'attachment; filename="Test Project.zip"', 'Content-Type': 'application/zip' },
            })
        )
      );
      const createUrl = vi.fn(() => 'blob:fake');
      const revokeUrl = vi.fn();
      Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true, writable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: revokeUrl, configurable: true, writable: true });
      try {
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const user = userEvent.setup();
        render(<ProjectDetailPage />);

        await user.click(await screen.findByRole('button', { name: /Export/ }));

        expect(await screen.findByText('Project exported')).toBeInTheDocument();
        expect(createUrl).toHaveBeenCalledTimes(1);
        expect(click).toHaveBeenCalledTimes(1);
        expect(revokeUrl).toHaveBeenCalledWith('blob:fake');
      } finally {
        restoreUrlDescriptors();
      }
    });

    it('toasts the error when the export fails', async () => {
      server.use(
        http.get('/api/v1/projects/:id/export', () => HttpResponse.json({ detail: 'Export unavailable' }, { status: 500 }))
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByRole('button', { name: /Export/ }));
      expect(await screen.findByText('Export unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Project exported')).not.toBeInTheDocument();
    });

    it('saves the project as a template, or toasts the failure', async () => {
      let fail = true;
      server.use(
        http.post('/api/v1/projects/:id/create-template', () =>
          fail ? HttpResponse.json({ detail: 'Template name taken' }, { status: 409 }) : HttpResponse.json(baseProject)
        )
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByRole('button', { name: /Save as Template/ }));
      expect(await screen.findByText('Template name taken')).toBeInTheDocument();
      fail = false;
      await user.click(screen.getByRole('button', { name: /Save as Template/ }));
      expect(await screen.findByText('Template created')).toBeInTheDocument();
    });

    it('does not offer saving a template as a template', async () => {
      useProject({ ...baseProject, is_template: true });
      render(<ProjectDetailPage />);

      await screen.findByText('Notes');
      expect(screen.queryByRole('button', { name: /Save as Template/ })).not.toBeInTheDocument();
    });
  });

  describe('edit modal', () => {
    it('opens the edit dialog from the header and closes it with Cancel', async () => {
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      const headerEdit = (await screen.findAllByRole('button', { name: 'Edit' }))[0];
      await user.click(headerEdit);
      const cancel = await screen.findByRole('button', { name: 'Cancel' });
      await user.click(cancel);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
    });
  });
});
