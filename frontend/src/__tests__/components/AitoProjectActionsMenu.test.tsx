import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ProjectActionsMenu } from '../../components/aito/ProjectActionsMenu';
import type { AitoProject } from '../../api/client';

const activeProject = { id: 12, status: 'active', quote_invoiced: false } as unknown as AitoProject;

type Row = 'merge' | 'split' | 'move' | 'copy' | 'print' | 'transfer' | 'watch' | 'forceSync' | 'duplicate' | 'trash';

const LABELS: Record<Row, string> = {
  merge: 'Merge another card…',
  split: 'Split into a new card…',
  move: 'Move tasks to another card…',
  copy: 'Copy summary',
  print: 'Print job ticket',
  transfer: 'Transfer to another client…',
  watch: 'Watch this card…',
  forceSync: 'Force Zoho sync',
  duplicate: 'Duplicate',
  trash: 'Move to trash',
};
const ROWS = Object.keys(LABELS) as Row[];

function callbacks() {
  return {
    onMerge: vi.fn(),
    onSplit: vi.fn(),
    onMoveTasks: vi.fn(),
    onCopySummary: vi.fn(),
    onPrintTicket: vi.fn(),
    onTransferClient: vi.fn(),
    onWatch: vi.fn(),
    onForceSync: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
  };
}

type Props = Parameters<typeof ProjectActionsMenu>[0];

function renderMenu(overrides: Partial<Props> = {}) {
  const cbs = callbacks();
  const props: Props = {
    project: activeProject,
    tasksCount: 3,
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    watchAvailable: true,
    ...cbs,
    ...overrides,
  };
  render(<ProjectActionsMenu {...props} />);
  return cbs;
}

const row = (r: Row) => screen.getByRole('menuitem', { name: new RegExp(`^${LABELS[r]}`) });

describe('ProjectActionsMenu', () => {
  it('is a ⋯ button that opens a labelled menu listing every card action, Trash last and set apart', async () => {
    const user = userEvent.setup();
    renderMenu();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'More actions' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    const menu = screen.getByRole('menu', { name: 'More actions' });
    expect(button).toHaveAttribute('aria-expanded', 'true');

    expect(within(menu).getAllByRole('menuitem').map((n) => n.textContent)).toEqual(ROWS.map((r) => LABELS[r]));
    // The one destructive row sits under a rule of its own.
    expect(row('trash').previousElementSibling).toHaveAttribute('role', 'separator');
    expect(row('trash').className).toContain('text-red-400');
  });

  // [case, overrides, rows expected disabled → their hint]. Every row not
  // listed must be enabled and hint-free: the matrix is exhaustive per case.
  const MATRIX: [string, Partial<Props>, Partial<Record<Row, string>>][] = [
    [
      'an invoiced card freezes everything that touches its tasks or client',
      { project: { ...activeProject, quote_invoiced: true } },
      { merge: 'Invoiced', split: 'Invoiced', move: 'Invoiced', transfer: 'Invoiced' },
    ],
    [
      'a trashed card keeps only the read-only rows and Duplicate',
      { project: { ...activeProject, status: 'deleted' } },
      {
        merge: 'In the trash',
        split: 'In the trash',
        move: 'In the trash',
        transfer: 'In the trash',
        watch: 'In the trash',
        forceSync: 'In the trash',
        trash: 'In the trash',
      },
    ],
    ['without the delete permission, Merge (it trashes the other card) and Trash', { canDelete: false }, {
      merge: 'No permission',
      trash: 'No permission',
    }],
    ['without the update permission, every row that edits the card', { canUpdate: false }, {
      merge: 'No permission',
      split: 'No permission',
      move: 'No permission',
      transfer: 'No permission',
      watch: 'No permission',
      forceSync: 'No permission',
    }],
    ['without the create permission, Split and Duplicate', { canCreate: false }, {
      split: 'No permission',
      duplicate: 'No permission',
    }],
    ['one task cannot be split', { tasksCount: 1 }, { split: 'Needs at least two tasks' }],
    ['no task can be neither split nor moved', { tasksCount: 0 }, {
      split: 'Needs at least two tasks',
      move: 'No tasks',
    }],
    ['a host that offers no delete', { onDelete: undefined }, { trash: 'No permission' }],
    ['a host that offers no duplicate', { onDuplicate: undefined }, { duplicate: 'No permission' }],
  ];

  it.each(MATRIX)('disables with a reason: %s', async (_name, overrides, expected) => {
    const user = userEvent.setup();
    const cbs = renderMenu(overrides);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    for (const r of ROWS) {
      const hint = expected[r];
      if (hint) {
        expect(row(r), r).toHaveAttribute('aria-disabled', 'true');
        expect(row(r), r).toHaveTextContent(`${LABELS[r]}${hint}`);
      } else {
        expect(row(r), r).not.toHaveAttribute('aria-disabled');
        expect(row(r).textContent, r).toBe(LABELS[r]);
      }
    }
    // A disabled row is inert: the menu stays up and nothing fires.
    const firstDisabled = ROWS.find((r) => expected[r])!;
    await user.click(row(firstDisabled));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    for (const fn of Object.values(cbs)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['merge', 'onMerge'],
    ['split', 'onSplit'],
    ['move', 'onMoveTasks'],
    ['copy', 'onCopySummary'],
    ['print', 'onPrintTicket'],
    ['transfer', 'onTransferClient'],
    ['watch', 'onWatch'],
    ['forceSync', 'onForceSync'],
    ['duplicate', 'onDuplicate'],
    ['trash', 'onDelete'],
  ] as const)('the %s row fires %s once and closes the menu', async (r, cb) => {
    const user = userEvent.setup();
    const cbs = renderMenu();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(row(r));
    expect(cbs[cb]).toHaveBeenCalledOnce();
    for (const [name, fn] of Object.entries(cbs)) if (name !== cb) expect(fn).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('labels the Watch row by whether this user already watches the card', async () => {
    const user = userEvent.setup();
    const cbs = renderMenu({ watching: true });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const watching = screen.getByRole('menuitem', { name: 'Watching…' });
    expect(screen.queryByRole('menuitem', { name: LABELS.watch })).not.toBeInTheDocument();
    // Still the way in: it reopens the dialog to change kinds or stop.
    expect(watching).not.toHaveAttribute('aria-disabled');
    await user.click(watching);
    expect(cbs.onWatch).toHaveBeenCalledOnce();
  });

  it('has no Watch row when there is no signed-in user to watch for', async () => {
    const user = userEvent.setup();
    renderMenu({ watchAvailable: false });
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const labels = screen.getAllByRole('menuitem').map((n) => n.textContent);
    expect(labels).toEqual(ROWS.filter((r) => r !== 'watch').map((r) => LABELS[r]));
  });

  it('opens on its shortcut key, but not while the operator is typing', () => {
    render(
      <>
        <input aria-label="field" />
        <ProjectActionsMenu
          project={activeProject}
          tasksCount={2}
          canCreate
          canUpdate
          canDelete
          {...callbacks()}
          shortcutKey="."
        />
      </>,
    );
    const input = screen.getByLabelText('field');
    input.focus();
    fireEvent.keyDown(window, { key: '.' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    input.blur();
    fireEvent.keyDown(window, { key: '.' });
    expect(screen.getByRole('menu', { name: 'More actions' })).toBeInTheDocument();
  });
});
