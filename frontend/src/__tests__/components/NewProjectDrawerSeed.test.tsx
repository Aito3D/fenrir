/**
 * NewProjectDrawer's `seed` (a new order started from a PDM project): the
 * drawer opens on the project's description and one task titled after it,
 * ignores whatever draft is persisted, and never writes or clears it — the
 * stored draft is the operator's own half-written card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewProjectDrawer } from '../../components/aito/NewProjectDrawer';
import { api } from '../../api/client';
import { defaultClientDraft } from '../../utils/clientDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';

const DEFAULT_ID = '66407000001237340';
const KEY = 'aito.newProjectDraft.v1';

vi.mock('../../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/client')>();
  return { ...mod, api: { ...mod.api, summarizeAitoProject: vi.fn() } };
});

const persisted = JSON.stringify({
  tasks: [{ ...emptyTaskDraft(), title: 'Capot moteur', scanCost: 10 }],
  client: { ...defaultClientDraft(DEFAULT_ID, 'Client de passage'), nationalNumber: '87123456' },
  summaryText: 'Brouillon en cours.',
  summaryEdited: true,
  summarySignature: '',
});

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true, reachable: true,
        default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([])),
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([])),
    http.get('/api/v1/calculator/printers/', () => HttpResponse.json([])),
    http.get('/api/v1/calculator/defaults', () => HttpResponse.json(null)),
    http.get('/api/v1/aito/shipping/services', () => HttpResponse.json({ services: [], catalogue_resolved: true })),
  );
  vi.mocked(api.summarizeAitoProject).mockResolvedValue({ summary: 'Résumé IA.', model: 'm' });
  localStorage.setItem(KEY, persisted);
  vi.mocked(localStorage.setItem).mockClear();
});

afterEach(() => vi.mocked(api.summarizeAitoProject).mockReset());

const seed = { description: 'Support caméra GoPro pour casque', taskTitle: 'P-0042 Support GoPro' };

describe('NewProjectDrawer seed', () => {
  it('starts from the seed, not the persisted draft', async () => {
    render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} seed={seed} />);
    await screen.findByText(/Client account — Client de passage/);

    expect(screen.getByDisplayValue('P-0042 Support GoPro')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Capot moteur')).not.toBeInTheDocument();
    expect(screen.queryByText(/Capot moteur/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Project summary')).toHaveValue('Support caméra GoPro pour casque');
  });

  it('writes nothing while open untouched, nor on unmount', async () => {
    const { unmount } = render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} seed={seed} />);
    await screen.findByText(/Client account — Client de passage/);
    // Past the 400ms save debounce.
    await new Promise((r) => setTimeout(r, 600));
    unmount();
    expect(localStorage.setItem).not.toHaveBeenCalledWith(KEY, expect.anything());
    expect(localStorage.getItem(KEY)).toBe(persisted);
  });

  it('keeps the seeded description through a summary pass (it counts as hand-written)', async () => {
    const user = userEvent.setup();
    render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} seed={seed} />);
    await screen.findByText(/Client account — Client de passage/);
    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    await user.click(screen.getByTestId('drawer-section-client'));
    expect(api.summarizeAitoProject).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Project summary')).toHaveValue('Support caméra GoPro pour casque');
  });

  it('edit and Create: onCreate gets keepStoredDraft true and the stored draft is untouched', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    const { unmount } = render(<NewProjectDrawer onClose={vi.fn()} onCreate={onCreate} seed={seed} />);
    await screen.findByText(/Client account — Client de passage/);
    await user.type(screen.getByDisplayValue('P-0042 Support GoPro'), ' v2');
    await user.click(screen.getByRole('button', { name: 'Add Scan' }));
    fireEvent.change(screen.getByLabelText('Scan Cost'), { target: { value: '10' } });
    await user.click(screen.getByTestId('drawer-section-client'));
    await user.type(screen.getByLabelText(/^phone$/i), '87123456');
    await user.click(screen.getByRole('button', { name: /Create Project/i }));

    expect(onCreate).toHaveBeenCalledWith(
      'Support caméra GoPro pour casque',
      expect.objectContaining({ id: DEFAULT_ID }),
      [expect.objectContaining({ title: 'P-0042 Support GoPro v2', scanCost: 10 })],
      null,
      null,
      false,
      { keepStoredDraft: true },
    );
    // Past the save debounce, then the unmount flush.
    await new Promise((r) => setTimeout(r, 600));
    unmount();
    expect(localStorage.setItem).not.toHaveBeenCalledWith(KEY, expect.anything());
    expect(localStorage.removeItem).not.toHaveBeenCalledWith(KEY);
    expect(localStorage.getItem(KEY)).toBe(persisted);
  });

  it('edit then close: the edits are discarded and the stored draft is untouched', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(<NewProjectDrawer onClose={onClose} onCreate={vi.fn()} seed={seed} />);
    await screen.findByText(/Client account — Client de passage/);
    await user.type(screen.getByDisplayValue('P-0042 Support GoPro'), ' v2');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 600));
    unmount();
    expect(localStorage.setItem).not.toHaveBeenCalledWith(KEY, expect.anything());
    expect(localStorage.getItem(KEY)).toBe(persisted);
  });

  it('without a seed still restores the persisted draft', async () => {
    render(<NewProjectDrawer onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(await screen.findByRole('heading', { level: 4, name: /Capot moteur/ })).toBeInTheDocument();
  });
});
