import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TabletBoard, type TabletBoardProps } from '../../components/aito/TabletBoard';
import { visibleCount } from '../../utils/aitoMobileBoard';
import { COLUMNS } from '../../components/aito/columns';
import { makeProject } from '../fixtures/aitoProject';

// jsdom: no layout. The board reads its width from getBoundingClientRect and
// each column's pitch from offsetLeft; stub both, and make scrollLeft a plain
// stored number.
let boardWidth = 900;
const COL = (w: number) => (w - 32 - 30 - (visibleCount(w) - 1) * 12) / visibleCount(w);
const saved: Record<string, PropertyDescriptor | undefined> = {};
type Stored = HTMLElement & { __sl?: number };
beforeEach(() => {
  boardWidth = 900;
  sessionStorage.clear();
  for (const k of ['scrollLeft', 'offsetLeft']) saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get() { return (this as Stored).__sl ?? 0; },
    set(v: number) { (this as Stored).__sl = v; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get() {
      const i = Number((this as HTMLElement).dataset.index ?? 0);
      return 16 + i * (COL(boardWidth) + 12);
    },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = (this as HTMLElement).dataset?.testid === 'aito-tablet-pager' ? boardWidth : 0;
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ['scrollLeft', 'offsetLeft']) {
    if (saved[k]) Object.defineProperty(HTMLElement.prototype, k, saved[k]!);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

function props(o: Partial<TabletBoardProps> = {}): TabletBoardProps {
  return {
    columns: COLUMNS.map((column) => ({ column, projects: column.id === 'devis' ? [makeProject({ id: 1, description: 'Raccord' })] : [] })),
    now: Date.parse('2026-09-27T12:00:00Z'),
    pending: false,
    loadingPill: null,
    filtering: false,
    search: '',
    onSearchChange: () => {},
    onExpandCard: () => {},
    followups: <span data-testid="followups" />,
    inProduction: 1,
    heading: <span>Aito 1</span>,
    doneCount: 7,
    onShowView: () => {},
    canCreate: true,
    onImport: () => {},
    onNewProject: () => {},
    ...o,
  };
}
const pitch = () => COL(boardWidth) + 12;
const range = () => screen.getByTestId('aito-tablet-range').textContent;

describe('visibleCount', () => {
  it('fits 280 px columns, between 2 and 4', () => {
    expect([560, 900, 1250, 2000].map(visibleCount)).toEqual([2, 3, 4, 4]);
  });
});

describe('TabletBoard', () => {
  it('shows a window of k columns and names it in the range picker', () => {
    render(<TabletBoard {...props()} />);
    expect(range()).toMatch(/Quote.*Scan/);
    expect(screen.getAllByTestId(/^aito-tablet-col-/)).toHaveLength(6);
  });

  it('follows a swipe', () => {
    render(<TabletBoard {...props()} />);
    const pager = screen.getByTestId('aito-tablet-pager');
    pager.scrollLeft = pitch() * 2;
    fireEvent.scroll(pager);
    expect(range()).toMatch(/Scan.*Printing/);
  });

  it('ensure-visible: a column right of the window becomes its last, a visible one does not move', async () => {
    const user = userEvent.setup();
    render(<TabletBoard {...props()} />);
    const pager = screen.getByTestId('aito-tablet-pager');
    await user.click(screen.getByTestId('aito-mobile-segment-scan'));
    expect(pager.scrollLeft).toBe(0);
    await user.click(screen.getByTestId('aito-mobile-segment-finish'));
    expect(Math.round(pager.scrollLeft)).toBe(Math.round(pitch() * 3));
  });

  it('arrows move one column and disappear at the ends', async () => {
    const user = userEvent.setup();
    render(<TabletBoard {...props()} />);
    expect(screen.queryByRole('button', { name: 'Previous column' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next column' }));
    expect(range()).toMatch(/Waiting.*Modeling/);
    await user.click(screen.getByRole('button', { name: 'Next column' }));
    await user.click(screen.getByRole('button', { name: 'Next column' }));
    expect(screen.queryByRole('button', { name: 'Next column' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Previous column' })).toBeInTheDocument();
  });

  it('re-aligns and clamps after the width changes', () => {
    sessionStorage.setItem('aito.tablet.first', 'model');
    render(<TabletBoard {...props()} />);
    expect(range()).toMatch(/Modeling.*Finish/);
    boardWidth = 1250;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(range()).toMatch(/Scan.*Finish/);
    expect(Math.round(screen.getByTestId('aito-tablet-pager').scrollLeft)).toBe(Math.round(pitch() * 2));
  });

  it('the range popover lists the columns and brings a pick into view', async () => {
    const user = userEvent.setup();
    render(<TabletBoard {...props()} />);
    await user.click(screen.getByTestId('aito-tablet-range'));
    const dialog = screen.getByRole('dialog', { name: 'Columns' });
    await user.click(within(dialog).getByRole('button', { name: /Finish/ }));
    expect(range()).toMatch(/Modeling.*Finish/);
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says "no results" in an empty column while searching', () => {
    render(<TabletBoard {...props({ filtering: true })} />);
    expect(screen.getByTestId('aito-tablet-col-scan')).toHaveTextContent('No projects match your search');
  });

  it('⋯ routes to the detours and import; + Projet creates', async () => {
    const user = userEvent.setup();
    const onShowView = vi.fn();
    const onImport = vi.fn();
    const onNewProject = vi.fn();
    render(<TabletBoard {...props({ onShowView, onImport, onNewProject })} />);
    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('menuitem', { name: /Trash/ }));
    expect(onShowView).toHaveBeenCalledWith('trash');
    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Import' }));
    expect(onImport).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: /Project/ }));
    expect(onNewProject).toHaveBeenCalledOnce();
  });

  it('opens a card and has no drag grip', async () => {
    const user = userEvent.setup();
    const onExpandCard = vi.fn();
    const { container } = render(<TabletBoard {...props({ onExpandCard })} />);
    await user.click(screen.getByRole('button', { name: 'Raccord' }));
    expect(onExpandCard).toHaveBeenCalledWith(1);
    expect(container.querySelector('.lucide-grip-vertical')).toBeNull();
  });
});
