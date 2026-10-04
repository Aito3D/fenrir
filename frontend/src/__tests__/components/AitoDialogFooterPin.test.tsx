/**
 * Pins the footer DOM of the four stacked Aito dialogs that share the
 * error-line + Cancel/confirm-with-spinner footer (merge, transfer client,
 * split/move tasks, watch) in their idle, disabled, pending and error states,
 * so extracting the footer into one component cannot shift a class, an
 * attribute or a node.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { MergeProjectModal } from '../../components/aito/MergeProjectModal';
import { TaskTransferModal } from '../../components/aito/TaskTransferModal';
import { TransferClientModal } from '../../components/aito/TransferClientModal';
import { WatchModal } from '../../components/aito/WatchModal';
import type { InboxPreferences } from '../../api/client';
import { makeProject } from '../fixtures/aitoProject';
import { emptyTaskDraft, type TaskDraft } from '../../utils/taskDraft';

/** The dialog's footer, with React's generated ids normalised away. */
function footerHtml(testId: string): string {
  const footer = screen.getByTestId(testId).querySelector('footer');
  if (!footer) throw new Error(`no footer in ${testId}`);
  return footer.outerHTML.replace(/(?:«|:)r[0-9a-z]+(?:»|:)/g, '«id»');
}

/** A request held open until the test lets it go: the mutation stays pending. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

const target = makeProject({ id: 41, description: 'Pièce carrosserie de BMW X3', client_id: 'z1' });
const board = [
  target,
  makeProject({ id: 33, description: 'Pièce de tambour en inox', client_name: 'PACIFIC MARINE', task_count: 2 }),
];

describe('MergeProjectModal footer', () => {
  it('keeps its disabled, idle, pending and error DOM', async () => {
    const held = gate();
    let fail = false;
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json(board)),
      http.post('/api/v1/aito/:id/merge', async () => {
        await held.opened;
        return fail
          ? HttpResponse.json({ detail: 'This project has been invoiced' }, { status: 409 })
          : HttpResponse.json(target);
      }),
    );
    const user = userEvent.setup();
    render(<MergeProjectModal project={target} onClose={vi.fn()} />);
    const rows = await screen.findAllByTestId('merge-candidate');
    expect(footerHtml('merge-project-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Merge</button></div></footer>"`);

    await user.click(rows[0]);
    expect(footerHtml('merge-project-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Merge</button></div></footer>"`);

    await user.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    expect(footerHtml('merge-project-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle h-4 w-4 animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>Merge</button></div></footer>"`);

    fail = true;
    held.release();
    await screen.findByText('This project has been invoiced');
    expect(footerHtml('merge-project-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400">This project has been invoiced</p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Merge</button></div></footer>"`);
  });
});

describe('TransferClientModal footer', () => {
  it('keeps its disabled, idle, pending and error DOM', async () => {
    const held = gate();
    server.use(
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({
          configured: true,
          reachable: null,
          default_contact_id: 'walkin',
          default_contact_name: 'Client comptoir',
        }),
      ),
      http.get('/api/v1/zoho/contacts', () =>
        HttpResponse.json([
          {
            id: 'z9',
            name: 'PACIFIC MARINE',
            company_name: '',
            customer_sub_type: 'individual',
            phone: '',
            mobile: '',
            email: '',
          },
        ]),
      ),
      http.put('/api/v1/aito/:id/transfer-client', async () => {
        await held.opened;
        return HttpResponse.json({ detail: 'Zoho said no' }, { status: 502 });
      }),
    );
    const user = userEvent.setup();
    render(<TransferClientModal project={target} onClose={vi.fn()} />);
    expect(footerHtml('transfer-client-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Transfer</button></div></footer>"`);

    await user.type(screen.getByRole('combobox'), 'pac');
    await user.click(await screen.findByRole('option', { name: /PACIFIC MARINE/ }));
    expect(footerHtml('transfer-client-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Transfer</button></div></footer>"`);

    await user.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    expect(footerHtml('transfer-client-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle h-4 w-4 animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>Transfer</button></div></footer>"`);

    held.release();
    await screen.findByText('Zoho said no');
    expect(footerHtml('transfer-client-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400">Zoho said no</p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Transfer</button></div></footer>"`);
  });
});

const task = (id: number | null, title: string): TaskDraft => ({ ...emptyTaskDraft(), id, title, scanCost: 500 });
const tasks = [task(501, 'Aile avant'), task(502, 'Pare-choc')];

describe('TaskTransferModal footer', () => {
  it('keeps the split footer DOM: disabled, idle, pending, error', async () => {
    const held = gate();
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json(board)),
      http.post('/api/v1/aito/:id/tasks/transfer', async () => {
        await held.opened;
        return HttpResponse.json({ detail: 'Split refused' }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    render(<TaskTransferModal project={target} tasks={tasks} mode="split" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Split</button></div></footer>"`);

    await user.click(screen.getByRole('checkbox', { name: /Aile avant/ }));
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Split</button></div></footer>"`);

    await user.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle h-4 w-4 animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>Split</button></div></footer>"`);

    held.release();
    await screen.findByText('Split refused');
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400">Split refused</p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Split</button></div></footer>"`);
  });

  it('keeps the split footer DOM while task saves are in flight', () => {
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json(board)));
    render(
      <TaskTransferModal project={target} tasks={tasks} mode="split" savesPending onClose={vi.fn()} onDone={vi.fn()} />,
    );
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p><p class="truncate text-xs text-bambu-gray">Waiting for the tasks to finish saving…</p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Split</button></div></footer>"`);
  });

  it('keeps the move footer DOM across both steps, and Back hands its button (and focus) to Cancel', async () => {
    const held = gate();
    server.use(
      http.get('/api/v1/aito/', () => HttpResponse.json(board)),
      http.post('/api/v1/aito/:id/tasks/transfer', async () => {
        await held.opened;
        return HttpResponse.json({ detail: 'Move refused' }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    render(<TaskTransferModal project={target} tasks={tasks} mode="move" onClose={vi.fn()} onDone={vi.fn()} />);
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Next</button></div></footer>"`);

    await user.click(screen.getByRole('checkbox', { name: /Aile avant/ }));
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Next</button></div></footer>"`);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Back</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Move</button></div></footer>"`);

    // Back and Cancel share one <button>: the node survives the step change, focus and all.
    const back = screen.getByRole('button', { name: 'Back' });
    await user.click(back);
    expect(back).toHaveTextContent('Cancel');
    expect(back).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click((await screen.findAllByTestId('merge-candidate'))[0]);
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Back</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Move</button></div></footer>"`);

    await user.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled());
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Back</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle h-4 w-4 animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>Move</button></div></footer>"`);

    held.release();
    await screen.findByText('Move refused');
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400">Move refused</p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Back</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Move</button></div></footer>"`);
  });

  it('keeps the move footer DOM while task saves are in flight', () => {
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json(board)));
    render(
      <TaskTransferModal project={target} tasks={tasks} mode="move" savesPending onClose={vi.fn()} onDone={vi.fn()} />,
    );
    expect(footerHtml('task-transfer-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><div class="min-w-0"><p role="alert" class="truncate text-xs text-red-400"></p><p class="truncate text-xs text-bambu-gray">Waiting for the tasks to finish saving…</p></div><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Cancel</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Next</button></div></footer>"`);
  });
});

const info = (kind: string) => ({ kind, family: 'aito', default_on: true, available: true });
const PREFS: InboxPreferences = {
  kinds: ['aito.quote_viewed', 'aito.paid'],
  sound_kinds: [],
  auto_watch: true,
  available: [info('aito.quote_viewed'), info('aito.paid')],
};

describe('WatchModal footer', () => {
  it('keeps its loading, idle, pending and error DOM on an unwatched card', async () => {
    const held = gate();
    server.use(
      http.get('/api/v1/inbox/preferences', () => HttpResponse.json(PREFS)),
      http.get('/api/v1/aito/:id/watch', () => HttpResponse.json({ watching: false, kinds: [] })),
      http.put('/api/v1/aito/:id/watch', async () => {
        await held.opened;
        return HttpResponse.json({ detail: 'Watch refused' }, { status: 409 });
      }),
    );
    const user = userEvent.setup();
    render(<WatchModal project={target} onClose={vi.fn()} />);
    expect(footerHtml('watch-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Save</button></div></footer>"`);

    await screen.findByRole('checkbox', { name: /^Quote opened by the client/ });
    expect(footerHtml('watch-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Save</button></div></footer>"`);

    await user.click(screen.getByRole('checkbox', { name: /^Quote opened by the client/ }));
    await user.click(screen.getByRole('checkbox', { name: /^Payment received/ }));
    expect(footerHtml('watch-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled="">Save</button></div></footer>"`);

    await user.click(screen.getByRole('checkbox', { name: /^Payment received/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(footerHtml('watch-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 " disabled=""><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-loader-circle h-4 w-4 animate-spin" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>Save</button></div></footer>"`);

    held.release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(footerHtml('watch-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400" title="Watch refused">Watch refused</p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Save</button></div></footer>"`);
  });

  it('keeps its Stop watching footer DOM on a watched card', async () => {
    server.use(
      http.get('/api/v1/inbox/preferences', () => HttpResponse.json(PREFS)),
      http.get('/api/v1/aito/:id/watch', () => HttpResponse.json({ watching: true, kinds: ['aito.paid'] })),
    );
    render(<WatchModal project={target} onClose={vi.fn()} />);
    await screen.findByRole('checkbox', { name: /^Payment received/ });
    expect(footerHtml('watch-modal')).toMatchInlineSnapshot(`"<footer class="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3"><p role="alert" class="min-w-0 truncate text-xs text-red-400"></p><div class="flex flex-none items-center gap-2"><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-dark-tertiary hover:bg-bambu-gray-dark text-white focus:ring-bambu-gray px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Stop watching</button><button class="btn-press inline-flex items-center justify-center font-medium rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-bambu-dark disabled:opacity-50 disabled:cursor-not-allowed bg-bambu-green hover:bg-bambu-green-light text-white focus:ring-bambu-green px-3 py-1.5 text-sm gap-1.5 min-h-[44px] md:min-h-0 ">Save</button></div></footer>"`);
  });
});
