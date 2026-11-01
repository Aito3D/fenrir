import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Clock, Package, ListOrdered, GanttChart, Workflow } from 'lucide-react';
import { useState } from 'react';
import { render } from '../../utils';
import { MobileQueue, type MobileQueueProps, type QueueTabId } from '../../../components/queue/mobile/MobileQueue';

const WIDTH = 390;
let widthSpy: PropertyDescriptor | undefined;
const scrollLeftStub: PropertyDescriptor & ThisType<HTMLElement & { __sl?: number }> = {
  configurable: true,
  get() { return this.__sl ?? 0; },
  set(value: number) { this.__sl = value; },
};
beforeEach(() => {
  widthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', scrollLeftStub);
});
afterEach(() => {
  if (widthSpy) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthSpy);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollLeft;
});

const tabs = [
  { id: 'queue' as const, label: 'Queue', icon: Clock, count: 3 },
  { id: 'batches' as const, label: 'Batches', icon: Package, count: 0 },
  { id: 'history' as const, label: 'History', icon: ListOrdered, count: 120 },
  { id: 'timeline' as const, label: 'Timeline', icon: GanttChart, count: null },
  { id: 'pipelines' as const, label: 'Pipelines', icon: Workflow, count: null },
];

function Harness({ start = 'queue', ...overrides }: Partial<MobileQueueProps> & { start?: QueueTabId }) {
  const [activeTab, setActiveTab] = useState<QueueTabId>(start);
  return (
    <MobileQueue
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      loading={false}
      renderTab={(tab) => <p>content:{tab}</p>}
      filters={{
        printers: [{ id: 1, name: 'X1C' }],
        filterPrinter: null, onFilterPrinter: () => {},
        filterStatus: '', onFilterStatus: () => {},
        locations: [], filterLocation: '', onFilterLocation: () => {},
      }}
      view={undefined}
      onClearHistory={null}
      {...overrides}
    />
  );
}

describe('MobileQueue', () => {
  it('names the current tab with its count and renders five pages, neighbours only', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Queue.*3.*Switch tab/ })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^queue-mobile-page-/)).toHaveLength(5);
    expect(screen.getByText('content:queue')).toBeInTheDocument();
    expect(screen.getByText('content:batches')).toBeInTheDocument();
    expect(screen.queryByText('content:history')).not.toBeInTheDocument();
  });

  it('lands on the starting tab before paint', () => {
    render(<Harness start="history" />);
    expect(screen.getByTestId('queue-mobile-pager').scrollLeft).toBe(WIDTH * 2);
    expect(screen.getByText('content:timeline')).toBeInTheDocument();
  });

  it('the strip has five equal segments and jumps', () => {
    render(<Harness />);
    const segments = screen.getAllByTestId(/^queue-mobile-segment-/);
    expect(segments).toHaveLength(5);
    expect(segments[0]).toHaveAttribute('aria-current', 'true');
    fireEvent.click(segments[3]);
    expect(segments[3]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /Timeline.*Switch tab/ })).toBeInTheDocument();
  });

  it('the tab sheet lists the five tabs and picks one without scrolling through the others', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /Switch tab/ }));
    const sheet = screen.getByRole('dialog', { name: 'Tabs' });
    expect(within(sheet).getAllByRole('button')).toHaveLength(5);
    await user.click(within(sheet).getByRole('button', { name: /History/ }));
    expect(screen.getByTestId('queue-mobile-pager').scrollLeft).toBe(WIDTH * 2);
    expect(screen.getByTestId('queue-mobile-pager').style.scrollSnapType).toBe('');
    // The sheet plays a 200 ms close animation before it unmounts.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Tabs' })).not.toBeInTheDocument());
  });

  it('follows a swipe', () => {
    render(<Harness />);
    const pager = screen.getByTestId('queue-mobile-pager');
    pager.scrollLeft = WIDTH * 4;
    fireEvent.scroll(pager);
    expect(screen.getByRole('button', { name: /Pipelines.*Switch tab/ })).toBeInTheDocument();
  });

  it('filter button: hidden without filters, dotted when one is set (Unassigned counts)', async () => {
    const { unmount } = render(<Harness filters={null} />);
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    unmount();
    render(
      <Harness
        filters={{
          printers: [], filterPrinter: -1, onFilterPrinter: () => {},
          filterStatus: '', onFilterStatus: () => {},
          locations: [], filterLocation: '', onFilterLocation: () => {},
        }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Filters' });
    expect(within(button).getByTestId('queue-mobile-filter-dot')).toBeInTheDocument();
    await userEvent.setup().click(button);
    expect(screen.getByTestId('queue-filter-sheet')).toBeInTheDocument();
  });

  it('⋯ shows Clear history only when given', async () => {
    const onClearHistory = vi.fn();
    const { unmount } = render(<Harness start="history" />);
    expect(screen.queryByRole('button', { name: 'More options' })).not.toBeInTheDocument();
    unmount();
    render(<Harness start="history" onClearHistory={onClearHistory} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More options' }));
    await user.click(screen.getByRole('menuitem', { name: /Clear History/i }));
    expect(onClearHistory).toHaveBeenCalled();
  });
  it('a settle scheduled before a tab change still adopts the page it lands on', () => {
    // The scroll that switches the tab also schedules the settle, so the
    // timer holds the handler from BEFORE the re-render; the stale closure
    // must not skip the tab change when the pager comes to rest elsewhere.
    vi.useFakeTimers();
    try {
      render(<Harness />);
      const pager = screen.getByTestId('queue-mobile-pager');
      pager.scrollLeft = WIDTH * 1;
      fireEvent.scroll(pager); // → Batches, settle scheduled by the old handler
      expect(screen.getByRole('button', { name: /Batches.*Switch tab/ })).toBeInTheDocument();
      pager.scrollLeft = WIDTH * 0.4; // drifted back towards Queue, no scroll event
      act(() => { vi.advanceTimersByTime(400); });
      expect(screen.getByRole('button', { name: /Queue.*Switch tab/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
