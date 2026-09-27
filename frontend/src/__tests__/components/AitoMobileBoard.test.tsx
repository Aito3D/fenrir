import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { MobileBoard, type MobileBoardProps } from '../../components/aito/MobileBoard';
import { COLUMNS } from '../../components/aito/columns';
import { MOBILE_COLUMN_STORAGE_KEY } from '../../hooks/useMobileColumn';
import { makeProject } from '../fixtures/aitoProject';

const WIDTH = 390;
let widthSpy: PropertyDescriptor | undefined;
// jsdom does no layout; make scrollLeft a plain stored number so the pager's
// writes can be read back. Defined on HTMLElement.prototype, shadowing
// Element's, and removed after each test.
const scrollLeftStub: PropertyDescriptor & ThisType<HTMLElement & { __sl?: number }> = {
  configurable: true,
  get() { return this.__sl ?? 0; },
  set(value: number) { this.__sl = value; },
};

function props(overrides: Partial<MobileBoardProps> = {}): MobileBoardProps {
  return {
    columns: COLUMNS.map((column) => ({
      column,
      projects: column.id === 'devis'
        ? [makeProject({ id: 1, column: 'devis', description: 'Raccord de durite' })]
        : column.id === 'print'
          ? [makeProject({ id: 2, column: 'print', description: 'Ailerons' })]
          : [],
    })),
    now: Date.parse('2026-09-27T12:00:00Z'),
    pending: false,
    loadingPill: null,
    filtering: false,
    search: '',
    onSearchChange: () => {},
    onExpandCard: () => {},
    heading: <span>Aito 2</span>,
    doneCount: 153,
    onShowView: () => {},
    canCreate: true,
    onImport: () => {},
    onNewProject: () => {},
    hideFab: false,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  widthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', scrollLeftStub);
});
afterEach(() => {
  if (widthSpy) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthSpy);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollLeft;
});

describe('MobileBoard', () => {
  it('renders one page per column and follows the swipe', () => {
    render(<MobileBoard {...props()} />);
    const pager = screen.getByTestId('aito-mobile-pager');
    expect(screen.getAllByTestId(/^aito-mobile-page-/)).toHaveLength(6);
    expect(screen.getByRole('button', { name: /Quote/, expanded: false })).toBeInTheDocument();
    pager.scrollLeft = WIDTH * 4;
    fireEvent.scroll(pager);
    expect(screen.getByRole('button', { name: /Printing/, expanded: false })).toHaveAttribute('aria-haspopup', 'dialog');
    expect(sessionStorage.getItem(MOBILE_COLUMN_STORAGE_KEY)).toBe('print');
  });

  it('restores the remembered column on mount', () => {
    sessionStorage.setItem(MOBILE_COLUMN_STORAGE_KEY, 'print');
    render(<MobileBoard {...props()} />);
    expect(screen.getByTestId('aito-mobile-pager').scrollLeft).toBe(WIDTH * 4);
  });

  it('jumps from the strip and from the sheet', async () => {
    const user = userEvent.setup();
    render(<MobileBoard {...props()} />);
    const pager = screen.getByTestId('aito-mobile-pager');
    await user.click(screen.getByTestId('aito-mobile-segment-scan'));
    expect(pager.scrollLeft).toBe(WIDTH * 2);
    await user.click(screen.getByRole('button', { name: /Scan/, expanded: false }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Finish/ }));
    expect(pager.scrollLeft).toBe(WIDTH * 5);
  });

  it('re-aligns to the current column after a resize', () => {
    render(<MobileBoard {...props()} />);
    const pager = screen.getByTestId('aito-mobile-pager');
    pager.scrollLeft = WIDTH * 4;
    fireEvent.scroll(pager);
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pager.scrollLeft).toBe(800 * 4);
  });

  it('opens a card on tap and keeps its footer actions', async () => {
    const user = userEvent.setup();
    const onExpandCard = vi.fn();
    render(<MobileBoard {...props({ onExpandCard })} />);
    await user.click(screen.getByRole('button', { name: 'Raccord de durite' }));
    expect(onExpandCard).toHaveBeenCalledWith(1);
    expect(screen.getByRole('button', { name: 'Mark as sent' })).toBeInTheDocument();
  });

  it('says "no results" on an empty page while searching, dashed box otherwise', () => {
    const { rerender } = render(<MobileBoard {...props()} />);
    expect(screen.getByTestId('aito-mobile-page-scan').querySelector('.border-dashed')).not.toBeNull();
    rerender(<MobileBoard {...props({ filtering: true })} />);
    expect(screen.getByTestId('aito-mobile-page-scan')).toHaveTextContent('No projects match your search');
  });

  it('the ⋯ menu routes to the detours with the done count', async () => {
    const user = userEvent.setup();
    const onShowView = vi.fn();
    render(<MobileBoard {...props({ onShowView })} />);
    await user.click(screen.getByRole('button', { name: 'More options' }));
    expect(screen.getByRole('menuitem', { name: /Show done/ })).toHaveTextContent('153');
    await user.click(screen.getByRole('menuitem', { name: 'Statistics' }));
    expect(onShowView).toHaveBeenCalledWith('stats');
  });

  it('the FAB opens import and new project', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    const onNewProject = vi.fn();
    render(<MobileBoard {...props({ onImport, onNewProject })} />);
    await user.click(screen.getByTestId('aito-mobile-fab'));
    await user.click(screen.getByRole('menuitem', { name: 'Import' }));
    expect(onImport).toHaveBeenCalledOnce();
    await user.click(screen.getByTestId('aito-mobile-fab'));
    await user.click(screen.getByRole('menuitem', { name: 'Project' }));
    expect(onNewProject).toHaveBeenCalledOnce();
  });

  it('hides the FAB without create permission, under a panel/drawer, and under the sheet', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MobileBoard {...props({ canCreate: false })} />);
    expect(screen.queryByTestId('aito-mobile-fab')).toBeNull();
    rerender(<MobileBoard {...props({ hideFab: true })} />);
    expect(screen.queryByTestId('aito-mobile-fab')).toBeNull();
    rerender(<MobileBoard {...props()} />);
    expect(screen.getByTestId('aito-mobile-fab')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Quote/, expanded: false }));
    expect(screen.queryByTestId('aito-mobile-fab')).toBeNull();
  });
});
