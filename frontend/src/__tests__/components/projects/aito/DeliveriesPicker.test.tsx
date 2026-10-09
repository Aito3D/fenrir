import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { DeliveriesPicker } from '../../../../components/projects/aito/DeliveriesPicker';

const ORDER = 42;
const TASK = 11;

const rev = (id: number, number: number, status: string) => ({
  id, number, status, note: null, derived_from: null, outdated_by: null, print_profile: null,
  slicer_name: null, slicer_version: null, has_snapshot: false, used: false, created_by: 'paul',
  created_at: '2026-10-04T10:00:00Z', status_changed_at: null, files: [],
});
const item = (id: number, section: string, name: string, revisions: ReturnType<typeof rev>[]) => ({
  id, section, name, name_key: name.toLowerCase(), forked_from: null, revisions,
});
const fullTree = {
  project_id: 7,
  code: 'P-0007',
  sections: [
    { section: 'scan', items: [] },
    { section: 'modelisation', items: [] },
    {
      section: 'impression',
      items: [
        item(30, 'impression', 'Plate', [rev(6, 2, 'valide'), rev(5, 1, 'valide')]),
        item(31, 'impression', 'Lid', [rev(9, 1, 'wip')]),
      ],
    },
    { section: 'usinage', items: [] },
    { section: 'docs', items: [] },
  ],
};
const emptyTree = { ...fullTree, sections: fullTree.sections.map((s) => ({ ...s, items: [] })) };

let puts: unknown[];
let putStatus: number;

beforeEach(() => {
  puts = [];
  putStatus = 200;
  server.use(
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json(fullTree)),
    http.get('/api/v1/projects/7/orders', () => HttpResponse.json({ orders: [] })),
    http.put(`/api/v1/aito/tasks/${TASK}/deliveries`, async ({ request }) => {
      puts.push(await request.json());
      if (putStatus !== 200) return HttpResponse.json({ detail: 'boom' }, { status: putStatus });
      return HttpResponse.json({ task_id: TASK, project: null, sections: {}, deliveries: [] });
    }),
  );
});

const renderPicker = (current: number[], onClose = vi.fn()) => {
  render(<DeliveriesPicker orderId={ORDER} taskId={TASK} projectId={7} current={current} onClose={onClose} />);
  return onClose;
};

describe('DeliveriesPicker', () => {
  it('unchecking a delivered revision leaves it out of the saved list', async () => {
    const user = userEvent.setup();
    const onClose = renderPicker([6, 9]);
    const dialog = await screen.findByRole('dialog');
    const box = async (name: RegExp) => (await within(dialog).findByRole('checkbox', { name })) as HTMLInputElement;
    expect((await box(/Plate R2/)).checked).toBe(true);
    await user.click(await box(/Plate R2/));
    expect((await box(/Plate R2/)).checked).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ revision_ids: [9] }]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('a failed save toasts, keeps the dialog open and preserves the checks', async () => {
    const user = userEvent.setup();
    putStatus = 500;
    const onClose = renderPicker([6]);
    const dialog = await screen.findByRole('dialog');
    const box = async (name: RegExp) => (await within(dialog).findByRole('checkbox', { name })) as HTMLInputElement;
    await user.click(await box(/Lid R1/));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
    expect(puts).toEqual([{ revision_ids: [6, 9] }]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect((await box(/Plate R2/)).checked).toBe(true);
    expect((await box(/Lid R1/)).checked).toBe(true);
    expect((await box(/Plate R1/)).checked).toBe(false);
    // The save button is usable again for a retry.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled());
  });

  it('suggests the newest approved revision and drops the item\'s other checks', async () => {
    const user = userEvent.setup();
    renderPicker([5]);
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('checkbox', { name: /Plate R2/ });
    await user.click(within(dialog).getByRole('button', { name: 'Suggest latest approved' }));
    const box = (name: RegExp) => within(dialog).getByRole('checkbox', { name }) as HTMLInputElement;
    expect(box(/Plate R2/).checked).toBe(true);
    expect(box(/Plate R1/).checked).toBe(false);
    expect(box(/Lid R1/).checked).toBe(false); // wip only: nothing to suggest
  });

  it('shows the empty state for a project without revisions', async () => {
    server.use(http.get('/api/v1/projects/7/tree', () => HttpResponse.json(emptyTree)));
    renderPicker([]);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('No items yet')).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
