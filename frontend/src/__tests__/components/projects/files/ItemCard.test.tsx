/** The Printing panel's item card (layout D): the shown revision's facts, its server slice state,
 *  the icon actions (no Re-slice), Open in slicer on the source file, and the details tray. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ItemCard } from '../../../../components/projects/files/ItemCard';
import { useFileActions } from '../../../../components/projects/files/useFileActions';
import type { ProjectItemOut } from '../../../../api/client';
import { openInSlicer } from '../../../../utils/slicer';
import { file, item, rev } from '../../../fixtures/projectTree';

vi.mock('../../../../utils/slicer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/slicer')>()),
  openInSlicer: vi.fn(),
}));
vi.mock('../../../../components/projects/print/PrintRevisionFlow', () => ({
  PrintRevisionFlow: ({ file: f }: { file: { filename: string } }) => <div data-testid="print-flow">{f.filename}</div>,
}));

const profile = { printer_model: 'X1C', nozzle_diameter: '0.4', layer_height: '0.2', filament_types: ['PETG'] };
const sliced = file(90, 'bracket.gcode.3mf', { file_type: 'gcode.3mf', print_time_seconds: 8040, filament_used_grams: 38.4 });
const bracket = (r2: Partial<Parameters<typeof rev>[0]> = {}): ProjectItemOut =>
  item(20, 'impression', 'Bracket', [
    rev({
      id: 2, number: 2, status: 'valide', print_profile: profile,
      files: [file(51, 'bracket.3mf', { file_type: '3mf', file_size: 3 * 1024 * 1024 })],
      slice_status: 'sliced', sliced_file: sliced, ...r2,
    }),
    rev({ id: 1, number: 1, status: 'obsolete', used: true, print_profile: { ...profile, layer_height: '0.28' },
      files: [file(50, 'bracket-old.3mf', { file_type: '3mf', file_size: 1024 })] }),
  ]);

function Harness({ value }: { value: ProjectItemOut }) {
  const actions = useFileActions(7);
  const [open, setOpen] = useState(false);
  return (
    <ul>
      <ItemCard item={value} actions={actions} open={open} onToggleDetails={() => setOpen((o) => !o)} />
    </ul>
  );
}

let calls: string[];
beforeEach(() => {
  calls = [];
  vi.mocked(openInSlicer).mockClear();
  server.use(
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json({ project_id: 7, code: 'P-0007', sections: [] })),
    http.post('/api/v1/projects/revisions/:id/slice', ({ params }) => {
      calls.push(`slice:${params.id}`);
      return HttpResponse.json({ job_id: 12, slice_status: 'slicing' }, { status: 202 });
    }),
    http.post('/api/v1/library/files/:id/slicer-token', ({ params }) => {
      calls.push(`token:${params.id}`);
      return HttpResponse.json({ token: 'tok' });
    }),
  );
});

const card = () => screen.getByTestId('item-card-20');

describe('ItemCard', () => {
  it('shows the newest revision: selected chip, status strip, name, facts and profile line', () => {
    render(<Harness value={bracket()} />);
    expect(within(card()).getByRole('button', { name: 'R2' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card()).getByRole('button', { name: 'R1' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('status-strip-20').className).toContain('bg-bambu-green');
    expect(within(card()).getByText('Bracket')).toBeInTheDocument();
    expect(within(card()).getByText('Approved')).toBeInTheDocument();
    expect(within(card()).getByText('3.0 MB')).toBeInTheDocument();
    expect(within(card()).getByText('2h 14m')).toBeInTheDocument();
    expect(within(card()).getByText('38.4 g')).toBeInTheDocument();
    expect(within(card()).getByText('X1C · 0.4 mm · 0.2 mm · PETG')).toBeInTheDocument();
    expect(within(card()).getByText('Sliced')).toBeInTheDocument();
    expect(within(card()).queryByText('Older revision')).not.toBeInTheDocument();
  });

  it('shows the live percent of a slicing revision as a progress bar', async () => {
    server.use(
      http.get('/api/v1/slice-jobs/12', () =>
        HttpResponse.json({
          job_id: 12, status: 'running', kind: 'project_revision', source_id: 2, source_name: 'bracket.3mf',
          created_at: '2026-10-17T10:00:00Z', started_at: null, completed_at: null,
          progress: { stage: 'Generating G-code', total_percent: 62.2, plate_percent: 0, plate_index: 1, plate_count: 1, updated_at: 0 },
        }),
      ),
    );
    render(<Harness value={bracket({ slice_status: 'slicing', slice_job_id: 12, sliced_file: null })} />);
    const bar = within(card()).getByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '62'));
    expect(within(card()).getByText('Slicing…')).toBeInTheDocument();
    expect(within(card()).getByText('62%')).toBeInTheDocument();
  });

  it('shows a failed slice with its error, and Retry posts the slice', async () => {
    render(<Harness value={bracket({ slice_status: 'failed', slice_error: 'Plate 2 is empty', sliced_file: null })} />);
    expect(within(card()).getByText('Slice failed: Plate 2 is empty')).toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toEqual(['slice:2']));
  });

  it('a legacy sliced revision (no server slice state) reads as sliced', () => {
    render(<Harness value={bracket({ slice_status: null, sliced_file: null, print_profile: { ...profile, sliced: true } })} />);
    expect(within(card()).getByText('Sliced')).toBeInTheDocument();
  });

  it('picking an older chip switches the card to that revision and dims it', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'R1' }));
    expect(within(card()).getByRole('button', { name: 'R1' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card()).getByText('Older revision')).toBeInTheDocument();
    expect(within(card()).getByText('X1C · 0.4 mm · 0.28 mm · PETG')).toBeInTheDocument();
    expect(within(card()).getByText('Obsolete')).toBeInTheDocument();
    expect(within(card()).getByText('Not sliced')).toBeInTheDocument();
    expect(screen.getByTestId('status-strip-20').className).toContain('bg-slate-500');
    expect(screen.getByTestId('card-thumb-20').className).toContain('opacity-40');
  });

  it('has the icon actions with accessible names and no Re-slice', () => {
    render(<Harness value={bracket()} />);
    for (const name of ['Print', 'Open in slicer', 'Preview', 'Download', 'More actions']) {
      const button = within(card()).getByRole('button', { name });
      expect(button).toHaveAttribute('title', name);
      // 44px touch targets below md, the panel's 32px-class icon buttons from md up.
      for (const cls of ['h-[44px]', 'min-w-[44px]', 'md:h-8', 'md:min-w-8']) expect(button.className.split(' ')).toContain(cls);
    }
    // One row: the five buttons never wrap.
    const row = within(card()).getByRole('button', { name: 'Print' }).parentElement!;
    expect(row.className.split(' ')).toContain('flex-nowrap');
    expect(row.className).not.toContain('flex-wrap ');
    expect(screen.queryByRole('button', { name: /Re-slice/ })).not.toBeInTheDocument();
  });

  it('Print opens the print flow with the source file', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Print' }));
    expect(screen.getByTestId('print-flow')).toHaveTextContent('bracket.3mf');
  });

  it('Open in slicer hands the source file to the desktop slicer', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open in slicer' }));
    await waitFor(() => expect(openInSlicer).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['token:51']);
    const [url, slicer] = vi.mocked(openInSlicer).mock.calls[0];
    expect(url).toBe(`${window.location.origin}/api/v1/library/files/51/dl/tok/bracket.3mf`);
    expect(slicer).toBe('bambu_studio');
  });

  it('Open in slicer follows the desktop slicer setting', async () => {
    server.use(http.get('/api/v1/settings/', () => HttpResponse.json({ open_in_slicer: 'orcaslicer', preferred_slicer: 'bambu_studio' })));
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open in slicer' }));
    await waitFor(() => expect(openInSlicer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(openInSlicer).mock.calls[0][1]).toBe('orcaslicer');
  });

  it('Open in slicer toasts a refused token and falls back to the plain download URL', async () => {
    server.use(http.post('/api/v1/library/files/:id/slicer-token', () => HttpResponse.json({ detail: 'no' }, { status: 403 })));
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open in slicer' }));
    expect(await screen.findByText('Could not open in slicer')).toBeInTheDocument();
    expect(vi.mocked(openInSlicer).mock.calls[0][0]).toBe(`${window.location.origin}/api/v1/library/files/51/download`);
  });

  it('a legacy sliced revision prints its own sliced file, and opens nothing in the slicer without a source', async () => {
    render(<Harness value={item(20, 'impression', 'Bracket', [rev({
      id: 2, number: 1, print_profile: { ...profile, sliced: true },
      files: [file(60, 'bracket.gcode.3mf', { file_type: 'gcode.3mf' })],
    })])} />);
    expect(within(card()).queryByRole('button', { name: 'Open in slicer' })).not.toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'Print' }));
    expect(screen.getByTestId('print-flow')).toHaveTextContent('bracket.gcode.3mf');
  });

  it('the ⋯ menu slices an unsliced revision', async () => {
    render(<Harness value={bracket({ slice_status: null, sliced_file: null })} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('button', { name: 'Download sliced file' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Slice' }));
    await waitFor(() => expect(calls).toEqual(['slice:2']));
  });

  it('the ⋯ menu offers the sliced file once sliced, and no Slice', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Download sliced file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Slice' })).not.toBeInTheDocument();
    for (const name of ['Details', 'Rename', 'Fork as new item']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('Details opens the tray with the revision status select and hold-to-delete item', async () => {
    render(<Harness value={bracket()} />);
    expect(screen.queryByTestId('item-tray-20')).not.toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    const tray = screen.getByTestId('item-tray-20');
    expect(tray.className).toContain('col-span-full');
    expect(within(within(tray).getByTestId('revision-2')).getByLabelText('Status')).toHaveValue('valide');
    expect(within(tray).getByRole('button', { name: 'Delete item' })).toBeInTheDocument();
    // The tray follows the picked chip.
    await userEvent.click(within(card()).getByRole('button', { name: 'R1' }));
    expect(within(tray).getByTestId('revision-1')).toBeInTheDocument();
  });
});
