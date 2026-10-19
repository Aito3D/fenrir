/**
 * Pins the rendered DOM of the files panel's chevron toggles (SectionBlock and
 * "Older files" headers via CollapsibleHeader, ItemCard's name button, ItemRow's expand
 * button) and of the amber OUTDATED chip at each of its sites (ItemCard's badge,
 * RevisionBlock, PrintRevisionPicker), closed and open, as exact outerHTML.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import { PrintRevisionPicker } from '../../../../components/projects/print/PrintRevisionPicker';
import { file, item, projectTree, ref, rev } from '../../../fixtures/projectTree';

const tree = projectTree({
  impression: [
    item(20, 'impression', 'Support', [rev({ id: 2, number: 2, status: 'valide', files: [file(50, 'support.3mf')] })]),
    item(30, 'impression', 'Support X1C', [
      rev({
        id: 3,
        number: 1,
        derived_from: ref(1, 'Support', 'modelisation', 1, 'obsolete'),
        outdated_by: ref(2, 'Support', 'modelisation', 2),
        files: [file(60, 'support.gcode.3mf', { file_type: 'gcode.3mf' })],
      }),
    ]),
  ],
  docs: [item(50, 'docs', 'Plan', [rev({ id: 5, number: 1, files: [file(80, 'plan.pdf')] })])],
});

beforeEach(() => {
  server.use(http.get('/api/v1/projects/7/tree', () => HttpResponse.json(tree)));
});

const chipOf = (el: HTMLElement) => within(el).getByText(/OUTDATED/i).outerHTML;

describe('files panel toggles (pinned DOM)', () => {
  it('SectionBlock header has no toggle; Older files header, open and closed', async () => {
    const user = userEvent.setup();
    render(<ProjectFilesPanel projectId={7} />);
    await screen.findByText('Printing');
    // The section is always open: no toggle button, its cards are rendered.
    expect(screen.queryByRole('button', { name: /^Printing/ })).not.toBeInTheDocument();
    const older = screen.getByRole('button', { name: 'Older files 1' });
    expect(older.outerHTML).toMatchInlineSnapshot(`"<button type="button" aria-expanded="false" class="flex min-h-[44px] w-full items-center gap-1.5 rounded-lg text-left md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right h-4 w-4 shrink-0 text-bambu-gray" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span>Older files</span> <span class="text-xs font-normal text-bambu-gray">1</span></button>"`);
    await user.click(older);
    expect(older.outerHTML).toMatchInlineSnapshot(`"<button type="button" aria-expanded="true" class="flex min-h-[44px] w-full items-center gap-1.5 rounded-lg text-left md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4 shrink-0 text-bambu-gray" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg><span>Older files</span> <span class="text-xs font-normal text-bambu-gray">1</span></button>"`);
  });

  it('ItemCard name button (toggles the tray), closed and open; ItemRow row in Older files', async () => {
    const user = userEvent.setup();
    render(<ProjectFilesPanel projectId={7} />);
    const toggle = await screen.findByRole('button', { name: 'Support X1C' });
    expect(toggle.outerHTML).toMatchInlineSnapshot(`"<button type="button" aria-expanded="false" title="Support X1C" class="block min-h-[44px] w-full truncate rounded text-left text-sm font-medium text-white md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40">Support X1C</button>"`);
    await user.click(toggle);
    expect(toggle.outerHTML).toMatchInlineSnapshot(`"<button type="button" aria-expanded="true" title="Support X1C" class="block min-h-[44px] w-full truncate rounded text-left text-sm font-medium text-white md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40">Support X1C</button>"`);
    await user.click(screen.getByRole('button', { name: 'Older files 1' }));
    const plan = screen.getByRole('button', { name: 'Plan' });
    expect(plan.outerHTML).toMatchInlineSnapshot(`"<button type="button" aria-expanded="false" class="flex min-h-[44px] min-w-0 flex-1 basis-40 items-center gap-1.5 rounded-lg text-left md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right h-4 w-4 shrink-0 text-bambu-gray" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg><span class="min-w-0 break-all text-sm font-medium text-white">Plan</span></button>"`);
    await user.click(plan);
    expect(plan.outerHTML).toMatchInlineSnapshot(`"<button type="button" aria-expanded="true" class="flex min-h-[44px] min-w-0 flex-1 basis-40 items-center gap-1.5 rounded-lg text-left md:min-h-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-4 w-4 shrink-0 text-bambu-gray" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg><span class="min-w-0 break-all text-sm font-medium text-white">Plan</span></button>"`);
  });
});

describe('OUTDATED chip (pinned DOM)', () => {
  it('ItemCard badge, then RevisionBlock chip once the tray opens', async () => {
    const user = userEvent.setup();
    render(<ProjectFilesPanel projectId={7} />);
    const toggle = await screen.findByRole('button', { name: 'Support X1C' });
    const card = toggle.closest('li')!;
    expect(chipOf(card)).toMatchInlineSnapshot(`"<span title="Outdated — based on Support R1, R2 approved since" class="absolute left-2 top-2 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-black">Outdated</span>"`);
    await user.click(toggle);
    expect(within(card).getAllByText(/OUTDATED/i)).toHaveLength(1);
    expect(chipOf(screen.getByTestId('revision-3'))).toMatchInlineSnapshot(`"<span class="inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium border-amber-500/40 bg-amber-500/10 text-amber-400 whitespace-normal">Outdated — based on Support R1, R2 approved since</span>"`);
  });

  it('PrintRevisionPicker chip', async () => {
    render(<PrintRevisionPicker projectId={7} onPick={vi.fn()} onClose={vi.fn()} />);
    const entry = await screen.findByTestId('pick-revision-3');
    expect(chipOf(entry)).toMatchInlineSnapshot(`"<span class="inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-normal border-amber-500/40 bg-amber-500/10 text-amber-400">Outdated — based on Support R1, R2 approved since</span>"`);
    expect(within(screen.getByTestId('pick-revision-2')).queryByText(/OUTDATED/i)).not.toBeInTheDocument();
  });
});
