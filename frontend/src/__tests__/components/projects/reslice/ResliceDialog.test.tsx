import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ResliceDialog } from '../../../../components/projects/reslice/ResliceDialog';

const file = (id: number, filename: string) => ({ id, filename, file_type: '3mf', file_size: 10, file_hash: 'h', has_thumbnail: false, created_at: '2026-10-07T10:00:00Z' });
const pipeline = (id: number, name: string) => ({ id, name, description: null, printer_preset: { source: 'local', id: '1' }, process_preset: { source: 'local', id: '2' }, filament_presets: [], bed_type: null, target_kind: 'printer_class', target_printer_id: null, target_model_class: 'H2D', fanout_strategy: 'max_parallel', created_by: null, created_at: '', updated_at: '' });
let orders: unknown[] = [];

beforeEach(() => {
  orders = [];
  server.use(
    http.get('/api/v1/slicer-pipelines/', () => HttpResponse.json({ pipelines: [pipeline(1, 'H2D PETG'), pipeline(2, 'P1S PLA')] })),
    http.post('/api/v1/slicer-pipelines/:id/check-eligibility', ({ params }) =>
      HttpResponse.json({ ok: params.id !== '2', target_kind: 'printer_class', target_printer_id: null, target_printer_name: null, target_model_class: 'H2D', printer_reports: [],
        issues: params.id === '2' ? [{ kind: 'printer_offline', slot_index: null, expected: null, actual: null }] : [] })),
    http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ orders })),
  );
});

describe('ResliceDialog', () => {
  it('slices with the picked pipeline, without queueing', async () => {
    const onStart = vi.fn();
    render(<ResliceDialog projectId={7} files={[file(50, 'support.3mf')]} initialFileId={50} onStart={onStart} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('radio', { name: /H2D PETG/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Slice' }));
    expect(onStart).toHaveBeenCalledWith(50, 1, undefined);
  });

  it('shows eligibility issues as warnings and still allows starting', async () => {
    const onStart = vi.fn();
    render(<ResliceDialog projectId={7} files={[file(50, 'support.3mf')]} initialFileId={50} onStart={onStart} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('radio', { name: /P1S PLA/ }));
    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Slice' })).toBeEnabled();
  });

  it('asks for the order before "Trancher + file" and passes it on', async () => {
    orders = [{ task_id: 31, order_id: 203, client_name: 'Dupont', task_title: 'Support', order_description: null, board_column: 'printing' },
              { task_id: 32, order_id: 188, client_name: 'Martin', task_title: 'Support', order_description: null, board_column: 'printing' }];
    const onStart = vi.fn();
    render(<ResliceDialog projectId={7} files={[file(50, 'support.3mf')]} initialFileId={50} onStart={onStart} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('radio', { name: /H2D PETG/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Slice + queue' }));
    await userEvent.click(await screen.findByRole('radio', { name: /Dupont/ }));
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(50, 1, 31));
  });

  it('queues with no task when the project has no open order', async () => {
    const onStart = vi.fn();
    render(<ResliceDialog projectId={7} files={[file(50, 'support.3mf')]} initialFileId={50} onStart={onStart} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('radio', { name: /H2D PETG/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Slice + queue' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(50, 1, null));
  });

  it('says so when there is no pipeline', async () => {
    server.use(http.get('/api/v1/slicer-pipelines/', () => HttpResponse.json({ pipelines: [] })));
    render(<ResliceDialog projectId={7} files={[file(50, 'support.3mf')]} initialFileId={50} onStart={() => {}} onClose={() => {}} />);
    expect(await screen.findByText(/No saved pipeline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
  });

  it('Escape in the order step goes back to the pipeline step without closing', async () => {
    orders = [{ task_id: 31, order_id: 203, client_name: 'Dupont', task_title: 'Support', order_description: null, board_column: 'printing' }];
    const onClose = vi.fn();
    render(<ResliceDialog projectId={7} files={[file(50, 'support.3mf')]} initialFileId={50} onStart={() => {}} onClose={onClose} />);
    await userEvent.click(await screen.findByRole('radio', { name: /H2D PETG/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Slice + queue' }));
    await screen.findByRole('radio', { name: /Dupont/ });
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('radio', { name: /H2D PETG/ })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says the pipelines could not be loaded instead of "no saved pipeline"', async () => {
    server.use(http.get('/api/v1/slicer-pipelines/', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<ResliceDialog projectId={7} files={[file(50, 'support.3mf')]} initialFileId={50} onStart={() => {}} onClose={() => {}} />);
    expect(await screen.findByText('Could not load pipelines.')).toBeInTheDocument();
    expect(screen.queryByText(/No saved pipeline/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Slice + queue' })).toBeDisabled();
  });
});
