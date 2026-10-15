import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createTestQueryClient } from '../../../utils';

// Pins the two Aito file drop zones (task row + board card): their DOM in idle
// and drag-over states, and that each of the three permissions gates the drop.
const perms = new Set<string>();
const hasPermission = vi.fn((p: string) => perms.has(p));
const showToast = vi.fn();
vi.mock('../../../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission }) }));
vi.mock('../../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));

import { TaskDropZone } from '../../../../components/projects/aito/TaskProjectRow';
import { useCardDrop } from '../../../../components/projects/aito/CardDropTarget';

const ALL = ['aito:update', 'projects:update', 'projects:read'];

function wrap(ui: ReactNode) {
  const client = createTestQueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Mirrors CardView's shell: title + handlers, `relative rounded-xl ${className}`. */
function CardShell({ disabled = false }: { disabled?: boolean }) {
  const drop = useCardDrop({ orderId: 42, disabled });
  return (
    <div data-testid="card" title={drop.title} {...drop.handlers} className={`relative rounded-xl ${drop.className}`}>
      <span>card</span>
      {drop.overlay}
    </div>
  );
}

const fileDrag = () => ({ dataTransfer: { types: ['Files'] } });
const fileDrop = () => ({
  dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.3mf')], items: [] },
});

beforeEach(() => {
  perms.clear();
  ALL.forEach((p) => perms.add(p));
  hasPermission.mockClear();
  showToast.mockClear();
});

describe('TaskDropZone pins', () => {
  const renderZone = () =>
    wrap(
      <TaskDropZone orderId={42} taskId={11} link={undefined}>
        <span>child</span>
      </TaskDropZone>,
    );

  it('idle and drag-over DOM', () => {
    renderZone();
    const zone = screen.getByTestId('task-drop-11');
    expect(zone.outerHTML).toMatchInlineSnapshot(`"<div data-testid="task-drop-11" class="rounded-[.6rem] "><span>child</span></div>"`);
    fireEvent.dragOver(zone, fileDrag());
    expect(zone.outerHTML).toMatchInlineSnapshot(`"<div data-testid="task-drop-11" class="rounded-[.6rem] outline-dashed outline-2 outline-offset-2 outline-bambu-green" title="Drop files to add them to the project"><span>child</span></div>"`);
  });

  it('a drop with every permission is handled (needs-project toast)', () => {
    renderZone();
    fireEvent.drop(screen.getByTestId('task-drop-11'), fileDrop());
    expect(showToast).toHaveBeenCalledWith('Link a project to this task first', 'info');
  });

  it.each(ALL)('without %s: no highlight, no drop handling', (missing) => {
    perms.delete(missing);
    renderZone();
    const zone = screen.getByTestId('task-drop-11');
    fireEvent.dragOver(zone, fileDrag());
    expect(zone.outerHTML).toMatchInlineSnapshot(`"<div data-testid="task-drop-11" class="rounded-[.6rem] "><span>child</span></div>"`);
    fireEvent.drop(zone, fileDrop());
    expect(showToast).not.toHaveBeenCalled();
  });

  it('asks the permissions in the same order', () => {
    renderZone();
    expect(hasPermission.mock.calls.slice(0, 3).map((c) => c[0])).toEqual(ALL);
  });
});

describe('useCardDrop pins', () => {
  it('idle and drag-over DOM', () => {
    wrap(<CardShell />);
    const card = screen.getByTestId('card');
    expect(card.outerHTML).toMatchInlineSnapshot(`"<div data-testid="card" class="relative rounded-xl "><span>card</span></div>"`);
    fireEvent.dragOver(card, fileDrag());
    expect(card.outerHTML).toMatchInlineSnapshot(`"<div data-testid="card" class="relative rounded-xl outline-dashed outline-2 outline-offset-2 outline-bambu-green" title="Drop files to add them to the project"><span>card</span></div>"`);
  });

  it('disabled: no handlers, no permission asked', () => {
    wrap(<CardShell disabled />);
    const card = screen.getByTestId('card');
    fireEvent.dragOver(card, fileDrag());
    expect(card.outerHTML).toMatchInlineSnapshot(`"<div data-testid="card" class="relative rounded-xl "><span>card</span></div>"`);
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it('a drop with every permission is handled (non-printable toast)', () => {
    wrap(<CardShell />);
    fireEvent.drop(screen.getByTestId('card'), {
      dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.txt')], items: [] },
    });
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it.each(ALL)('without %s: no highlight, no drop handling', (missing) => {
    perms.delete(missing);
    wrap(<CardShell />);
    const card = screen.getByTestId('card');
    fireEvent.dragOver(card, fileDrag());
    expect(card.outerHTML).toMatchInlineSnapshot(`"<div data-testid="card" class="relative rounded-xl "><span>card</span></div>"`);
    fireEvent.drop(card, { dataTransfer: { types: ['Files'], files: [new File(['x'], 'a.txt')], items: [] } });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('asks the permissions in the same order', () => {
    wrap(<CardShell />);
    expect(hasPermission.mock.calls.slice(0, 3).map((c) => c[0])).toEqual(ALL);
  });
});
