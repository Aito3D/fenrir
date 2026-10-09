/**
 * ProjectDetailPage: error / not-found states, the optional cards (progress,
 * cost, queue, sub-projects, prints grid), and the BOM, notes, export and
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

function bomItem(overrides: Record<string, unknown>) {
  return {
    id: 1,
    project_id: 1,
    name: 'M3 screws',
    quantity_needed: 4,
    quantity_acquired: 0,
    unit_price: null,
    sourcing_url: null,
    remarks: null,
    is_complete: false,
    ...overrides,
  };
}

function useProject(project: Record<string, unknown>) {
  server.use(http.get('/api/v1/projects/:id', () => HttpResponse.json(project)));
}

function useBom(items: Record<string, unknown>[]) {
  server.use(http.get('/api/v1/projects/:id/bom', () => HttpResponse.json(items)));
}

describe('ProjectDetailPage actions and states', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    server.use(
      http.get('/api/v1/projects/:id/tree', () => HttpResponse.json({ project_id: 1, code: null, sections: [] })),
      http.get('/api/v1/projects/:id', () => HttpResponse.json(baseProject)),
      http.get('/api/v1/projects/:id/archives', () => HttpResponse.json([])),
      http.get('/api/v1/projects/:id/bom', () => HttpResponse.json([])),
      http.get('/api/v1/projects/:id/timeline', () => HttpResponse.json([])),
      http.get('/api/v1/library/folders/by-project/:id', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', () => HttpResponse.json([]))
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    it('shows the empty-state copy for prints, bom, timeline, notes and folders', async () => {
      render(<ProjectDetailPage />);

      expect(await screen.findByText('No prints in this project yet')).toBeInTheDocument();
      expect(screen.getByText(/No parts in the bill of materials/)).toBeInTheDocument();
      expect(screen.getByText('No activity yet.')).toBeInTheDocument();
      expect(screen.getByText(/No notes yet/)).toBeInTheDocument();
      expect(screen.getByText(/No folders linked/)).toBeInTheDocument();
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
      expect(screen.getByText('2 / 8 parts')).toBeInTheDocument();
      expect(screen.getByText('100% complete')).toBeInTheDocument();
      expect(screen.getByText('Complete Sets')).toBeInTheDocument();
      expect(screen.getByText('0 / 2 sets')).toBeInTheDocument();
    });

    it('shows cost, energy, wear, total with BOM and the remaining budget', async () => {
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

      expect(await screen.findByText('Cost Tracking')).toBeInTheDocument();
      expect(screen.getByText('$20.00')).toBeInTheDocument();
      expect(screen.getByText(/1\.500 kWh/)).toBeInTheDocument();
      expect(screen.getByText('($0.50)')).toBeInTheDocument();
      expect(screen.getByText('Printer Wear')).toBeInTheDocument();
      expect(screen.getByText('$32.50')).toBeInTheDocument();
      expect(screen.getByText('incl. BOM')).toBeInTheDocument();
      expect(screen.getByText('$100.00')).toBeInTheDocument();
      expect(screen.getByText('$67.50')).toBeInTheDocument();
    });

    it('flags an exceeded budget with a negative remainder', async () => {
      useProject({ ...baseProject, budget: 3, stats: { ...baseStats, estimated_cost: 5 } });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('$-2.00')).toBeInTheDocument();
    });

    it('shows urgent priority and an overdue due date', async () => {
      useProject({ ...baseProject, priority: 'urgent', due_date: '2020-01-01T00:00:00Z', stats: baseStats });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('Urgent')).toBeInTheDocument();
      expect(screen.getByText('(Overdue)')).toBeInTheDocument();
    });

    it('shows days left for a due date a few days out', async () => {
      const due = new Date(Date.now() + 2.5 * 24 * 3600 * 1000).toISOString();
      useProject({ ...baseProject, priority: 'high', due_date: due, stats: baseStats });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('High')).toBeInTheDocument();
      expect(screen.getByText('(3 days left)')).toBeInTheDocument();
    });

    it('shows the queue card with a link to the project queue', async () => {
      useProject({ ...baseProject, stats: { ...baseStats, queued_prints: 2, in_progress_prints: 1 } });
      render(<ProjectDetailPage />);

      expect(await screen.findByText('1 printing')).toBeInTheDocument();
      expect(screen.getByText('2 queued')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/queue?project=1');
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
  });

  describe('bill of materials', () => {
    it('adds a part and toasts, sending the typed fields', async () => {
      let body: Record<string, unknown> | null = null;
      server.use(
        http.post('/api/v1/projects/:id/bom', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(bomItem({ name: 'Bolt' }));
        })
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByRole('button', { name: /Add Part/ }));
      const submit = screen.getAllByRole('button', { name: 'Add Part' }).find((b) => b.getAttribute('type') === 'submit')!;
      expect(submit).toBeDisabled();
      await user.type(screen.getByPlaceholderText('Part name (e.g., M3x8 screws)'), '  Bolt  ');
      await user.type(screen.getByPlaceholderText('Remarks (optional)'), 'zinc');
      await user.type(screen.getByPlaceholderText('Sourcing URL (optional)'), 'https://shop.example/bolt');
      await user.click(submit);

      expect(await screen.findByText('Part added')).toBeInTheDocument();
      expect(body).toMatchObject({ name: 'Bolt', quantity_needed: 1, remarks: 'zinc', sourcing_url: 'https://shop.example/bolt' });
      // the form closes again
      expect(screen.queryByPlaceholderText('Part name (e.g., M3x8 screws)')).not.toBeInTheDocument();
    });

    it('keeps the form open and shows the server error when adding fails', async () => {
      server.use(
        http.post('/api/v1/projects/:id/bom', () => HttpResponse.json({ detail: 'BOM is locked' }, { status: 409 }))
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByRole('button', { name: /Add Part/ }));
      await user.type(screen.getByPlaceholderText('Part name (e.g., M3x8 screws)'), 'Bolt');
      await user.click(screen.getAllByRole('button', { name: 'Add Part' }).find((b) => b.getAttribute('type') === 'submit')!);

      expect(await screen.findByText('BOM is locked')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Part name (e.g., M3x8 screws)')).toHaveValue('Bolt');
    });

    it('cancels the add form', async () => {
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByRole('button', { name: /Add Part/ }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByPlaceholderText('Part name (e.g., M3x8 screws)')).not.toBeInTheDocument();
    });

    it('shows part price, sourcing host, remarks and the BOM total', async () => {
      useProject({ ...baseProject, stats: { ...baseStats, bom_total_items: 2, bom_completed_items: 1, bom_cost: 12.5 } });
      useBom([
        bomItem({ id: 1, unit_price: 2.5, quantity_needed: 4, sourcing_url: 'https://www.shop.example/p/1', remarks: 'zinc' }),
        bomItem({ id: 2, name: 'Insert', is_complete: true, quantity_acquired: 4, sourcing_url: 'not a url' }),
      ]);
      render(<ProjectDetailPage />);

      expect(await screen.findByText('(1/2 acquired)')).toBeInTheDocument();
      expect(screen.getByText('$10.00')).toBeInTheDocument();
      expect(screen.getByText('shop.example')).toBeInTheDocument();
      expect(screen.getByText('not a url')).toBeInTheDocument();
      expect(screen.getByText('zinc')).toBeInTheDocument();
      expect(screen.getByText('Total cost:')).toBeInTheDocument();
    });

    it('hides and shows completed parts', async () => {
      useBom([bomItem({ id: 1 }), bomItem({ id: 2, name: 'Insert', is_complete: true, quantity_acquired: 4 })]);
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await screen.findByText('Insert');
      await user.click(screen.getByRole('button', { name: 'Hide done' }));
      expect(screen.queryByText('Insert')).not.toBeInTheDocument();
      expect(screen.getByText('M3 screws')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Show all' }));
      expect(screen.getByText('Insert')).toBeInTheDocument();
    });

    it('marks a part acquired with its full quantity, and clears it again', async () => {
      useBom([bomItem({ id: 1 }), bomItem({ id: 2, name: 'Insert', is_complete: true, quantity_acquired: 4 })]);
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.patch('/api/v1/projects/:id/bom/:itemId', async ({ request, params }) => {
          bodies.push({ itemId: params.itemId, ...((await request.json()) as Record<string, unknown>) });
          return HttpResponse.json(bomItem({}));
        })
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await screen.findByText('Insert');
      const toggles = screen
        .getAllByRole('button')
        .filter((b) => b.className.includes('w-5 h-5 mt-0.5'));
      expect(toggles).toHaveLength(2);
      await user.click(toggles[0]);
      await waitFor(() => expect(bodies).toHaveLength(1));
      await user.click(toggles[1]);
      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[0]).toEqual({ itemId: '1', quantity_acquired: 4 });
      expect(bodies[1]).toEqual({ itemId: '2', quantity_acquired: 0 });
    });

    it('edits a part inline and saves the trimmed values', async () => {
      useBom([bomItem({ id: 7, unit_price: 1.5, sourcing_url: 'https://a.example/x', remarks: 'old' })]);
      let body: Record<string, unknown> | null = null;
      server.use(
        http.patch('/api/v1/projects/:id/bom/:itemId', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(bomItem({ id: 7 }));
        })
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByTitle('Edit', { selector: 'button' }));
      const name = screen.getByPlaceholderText('Part name');
      expect(name).toHaveValue('M3 screws');
      await user.clear(name);
      await user.type(name, ' M4 screws ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(body).not.toBeNull());
      expect(body).toMatchObject({
        name: 'M4 screws',
        quantity_needed: 4,
        unit_price: 1.5,
        sourcing_url: 'https://a.example/x',
        remarks: 'old',
      });
      await waitFor(() => expect(screen.queryByPlaceholderText('Part name')).not.toBeInTheDocument());
    });

    it('cancels an inline edit without saving, and surfaces a failed save', async () => {
      useBom([bomItem({ id: 7 })]);
      server.use(
        http.patch('/api/v1/projects/:id/bom/:itemId', () => HttpResponse.json({ detail: 'Cannot update part' }, { status: 400 }))
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByTitle('Edit', { selector: 'button' }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByPlaceholderText('Part name')).not.toBeInTheDocument();

      await user.click(screen.getByTitle('Edit', { selector: 'button' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText('Cannot update part')).toBeInTheDocument();
      // still editing: the failed save did not close the form
      expect(screen.getByPlaceholderText('Part name')).toBeInTheDocument();
    });

    it('asks for confirmation before deleting a part, then removes it', async () => {
      useBom([bomItem({ id: 7 })]);
      let deleted: string | readonly string[] | undefined;
      server.use(
        http.delete('/api/v1/projects/:id/bom/:itemId', ({ params }) => {
          deleted = params.itemId;
          return HttpResponse.json({ status: 'ok', message: 'deleted' });
        })
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByTitle('Delete', { selector: 'button' }));
      expect(screen.getByText('Are you sure you want to delete "M3 screws"?')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(deleted).toBeUndefined();
      expect(screen.queryByText(/Are you sure you want to delete/)).not.toBeInTheDocument();

      await user.click(screen.getByTitle('Delete', { selector: 'button' }));
      await user.click(screen.getByText('Delete', { selector: 'button' }));
      expect(await screen.findByText('Part removed')).toBeInTheDocument();
      expect(deleted).toBe('7');
    });

    it('toasts the server error when a part cannot be deleted', async () => {
      useBom([bomItem({ id: 7 })]);
      server.use(
        http.delete('/api/v1/projects/:id/bom/:itemId', () => HttpResponse.json({ detail: 'Part is in use' }, { status: 409 }))
      );
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByTitle('Delete', { selector: 'button' }));
      await user.click(screen.getByText('Delete', { selector: 'button' }));
      expect(await screen.findByText('Part is in use')).toBeInTheDocument();
      expect(screen.getByText('M3 screws')).toBeInTheDocument();
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
      const notesCard = screen.getByText('Notes').closest('div.flex')!.parentElement as HTMLElement;
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
      const notesCard = screen.getByText('Notes').closest('div.flex')!.parentElement as HTMLElement;
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
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      const user = userEvent.setup();
      render(<ProjectDetailPage />);

      await user.click(await screen.findByRole('button', { name: /Export/ }));

      expect(await screen.findByText('Project exported')).toBeInTheDocument();
      expect(createUrl).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revokeUrl).toHaveBeenCalledWith('blob:fake');
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
