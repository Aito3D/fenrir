/**
 * The timeline draws each lane's pending jobs chained end to end, so the order
 * it chains them in is a claim about what the scheduler will dispatch next.
 *
 * It used to chain by queue position alone, which meant turning
 * Shortest-Job-First on changed the scheduler and the pending list but left
 * the timeline drawing the pre-SJF queue forever (#3043).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueueTimelineView, HOVER_CARD_DWELL_MS } from '../../components/QueueTimelineView';
import type { PrintQueueItem, Printer } from '../../api/client';

const HOUR = 3600;

const printers = [{ id: 1, name: 'Workshop X1C', model: 'X1C' }] as unknown as Printer[];

// Something has to be running for a lane to forecast at all: an idle printer's
// ASAP queue has no committed anchor to chain from, so the view drops it.
const running = {
  id: 100,
  printer_id: 1,
  status: 'printing',
  position: 0,
  archive_name: 'Running now',
  print_time_seconds: HOUR,
  started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
} as unknown as PrintQueueItem;

const pending = (
  id: number,
  name: string,
  position: number,
  printTimeSeconds: number,
  over: Partial<PrintQueueItem> = {},
) =>
  ({
    id,
    printer_id: 1,
    status: 'pending',
    position,
    archive_name: name,
    print_time_seconds: printTimeSeconds,
    scheduled_time: null,
    manual_start: false,
    waiting_reason: null,
    ...over,
  }) as unknown as PrintQueueItem;

const queueItems = [
  running,
  pending(1, 'Long job', 1, 2 * HOUR),
  pending(2, 'Short job', 2, HOUR / 2),
  pending(3, 'Medium job', 3, HOUR),
];

function renderTimeline(sjfEnabled: boolean) {
  render(
    <QueueTimelineView
      queueItems={queueItems}
      printers={printers}
      printerStatuses={{ 1: { progress: 50, remaining_time: 30, state: 'RUNNING' } }}
      sjfEnabled={sjfEnabled}
      onItemClick={() => {}}
      t={(key: string) => key}
    />,
  );
}

/** Bar names, left to right. Bars are absolutely positioned, so the rendered
 *  offset is what the user reads -- not DOM order. The accessible name leads
 *  with the display name, which is cleaner to match on than the bar's own
 *  text (name and duration sit in adjacent divs with no separator). */
function barsLeftToRight(): string[] {
  return screen
    .getAllByRole('button')
    .filter(el => el.style.left.endsWith('%'))
    .sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left))
    .map(el => (el.getAttribute('aria-label') ?? '').split(' \u00b7 ')[0]);
}

describe('QueueTimelineView job ordering', () => {
  it('chains by queue position when SJF is off', () => {
    renderTimeline(false);
    expect(barsLeftToRight()).toEqual(['Running now', 'Long job', 'Short job', 'Medium job']);
  });

  it('chains shortest-first when SJF is on', () => {
    renderTimeline(true);
    expect(barsLeftToRight()).toEqual(['Running now', 'Short job', 'Medium job', 'Long job']);
  });

  it('keeps a jumped item ahead of a shorter one', () => {
    // The starvation guard is part of the scheduler's order too, so the
    // timeline has to draw it or it lies about the long job that is finally
    // about to run.
    render(
      <QueueTimelineView
        queueItems={[
          running,
          pending(1, 'Short job', 1, HOUR / 2),
          pending(2, 'Long job', 2, 2 * HOUR, { been_jumped: true }),
        ]}
        printers={printers}
        printerStatuses={{ 1: { progress: 50, remaining_time: 30, state: 'RUNNING' } }}
        sjfEnabled
        onItemClick={() => {}}
        t={(key: string) => key}
      />,
    );
    // Position order would put the short job first, so this only passes if
    // been_jumped is actually consulted.
    expect(barsLeftToRight()).toEqual(['Running now', 'Long job', 'Short job']);
  });
});

describe('QueueTimelineView and the scheduler waiting reasons (#3074)', () => {
  /** The scheduler now puts a reason on a pinned item too, and the commonest
   *  one by far -- "Busy: <printer>" -- describes the very chain this view
   *  forecasts. Dropping every item that has a reason would empty the timeline
   *  for anyone whose queue is pinned to specific printers. */
  function renderWith(items: PrintQueueItem[]) {
    render(
      <QueueTimelineView
        queueItems={items}
        printers={printers}
        printerStatuses={{ 1: { progress: 50, remaining_time: 30, state: 'RUNNING' } }}
        sjfEnabled={false}
        onItemClick={() => {}}
        t={(key: string) => key}
      />,
    );
  }

  it('still forecasts an item that is only waiting its turn', () => {
    renderWith([
      running,
      pending(1, 'Long job', 1, 2 * HOUR, { waiting_reason: 'Busy: X1C-01' }),
      pending(2, 'Medium job', 2, HOUR, { waiting_reason: 'Busy: X1C-01' }),
    ]);
    expect(barsLeftToRight()).toEqual(['Running now', 'Long job', 'Medium job']);
  });

  it('still forecasts one held behind a drying cycle', () => {
    renderWith([running, pending(1, 'Long job', 1, 2 * HOUR, { waiting_reason: 'Busy: X1C-01 (drying)' })]);
    expect(barsLeftToRight()).toEqual(['Running now', 'Long job']);
  });

  it('drops one that is waiting for the user', () => {
    // These do not start on their own, so a bar would be a promise the queue
    // cannot keep.
    for (const reason of [
      'Waiting for plate confirmation: X1C-01',
      'Offline, no Auto On smart plug: X1C-01',
      'Waiting on Enclosure Door',
      'Waiting for filament: X1C-01 (needs PETG)',
    ]) {
      const { unmount } = render(
        <QueueTimelineView
          queueItems={[running, pending(1, 'Long job', 1, 2 * HOUR, { waiting_reason: reason })]}
          printers={printers}
          printerStatuses={{ 1: { progress: 50, remaining_time: 30, state: 'RUNNING' } }}
          sjfEnabled={false}
          onItemClick={() => {}}
          t={(key: string) => key}
        />,
      );
      expect(barsLeftToRight()).toEqual(['Running now']);
      unmount();
    }
  });
});

/**
 * Hovering a bar opens a card with what the bar truncates: the schedule, the
 * print settings and the PDM project / Aito client behind the job. A sweep
 * across lanes must not flash a card per bar, so it waits a short dwell.
 */
describe('QueueTimelineView hover card', () => {
  const linked = pending(7, 'Guide sangle v2', 1, 4 * HOUR, {
    filament_type: 'PA-CF',
    filament_used_grams: 64,
    bed_type: 'Engineering Plate',
    nozzle_diameter: 0.4,
    layer_height: 0.16,
    project_code: 'PRJ-0151',
    project_name: 'Sangles Hiva Oa',
    revision_item_name: 'Guide sangle',
    revision_number: 2,
    revision_status: 'valide',
    aito_task_id: 12,
    aito_task_title: 'Guides sangle ×4',
    aito_client_name: 'Hiva Oa Nautique',
    aito_due_date: '2026-10-19',
    aito_quantity: 4,
    aito_board_column: 'print',
  });

  function renderWithLinked(items: PrintQueueItem[] = [running, linked]) {
    render(
      <QueueTimelineView
        queueItems={items}
        printers={printers}
        printerStatuses={{ 1: { progress: 50, remaining_time: 30, state: 'RUNNING' } }}
        sjfEnabled={false}
        onItemClick={() => {}}
        t={(key: string) => key}
      />,
    );
  }

  const bar = (name: string) =>
    screen.getAllByRole('button').find(el => (el.getAttribute('aria-label') ?? '').startsWith(name))!;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after the dwell, not on entry', () => {
    renderWithLinked();
    fireEvent.mouseEnter(bar('Guide sangle v2'));
    expect(screen.queryByTestId('queue-job-hover-card')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_DWELL_MS);
    });
    const card = screen.getByTestId('queue-job-hover-card');
    expect(card).toHaveTextContent('Guide sangle v2');
    expect(card).toHaveTextContent('PRJ-0151');
    expect(card).toHaveTextContent('Sangles Hiva Oa');
    expect(card).toHaveTextContent('R2');
    expect(card).toHaveTextContent('projectsPdm.files.statusValide');
    expect(card).toHaveTextContent('Hiva Oa Nautique');
    expect(card).toHaveTextContent('Guides sangle ×4');
    expect(card).toHaveTextContent('aito.columns.print');
    expect(card).toHaveTextContent('PA-CF');
    expect(card).toHaveTextContent('64 g');
    expect(card).toHaveTextContent('Engineering Plate');
  });

  it('never opens for a bar the pointer only crossed', () => {
    renderWithLinked();
    fireEvent.mouseEnter(bar('Guide sangle v2'));
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_DWELL_MS / 2);
    });
    fireEvent.mouseLeave(bar('Guide sangle v2'));
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_DWELL_MS * 2);
    });
    expect(screen.queryByTestId('queue-job-hover-card')).toBeNull();
  });

  it('stays open while the pointer is inside the card, closes on Escape', () => {
    renderWithLinked();
    fireEvent.mouseEnter(bar('Guide sangle v2'));
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_DWELL_MS);
    });
    const card = screen.getByTestId('queue-job-hover-card');
    fireEvent.mouseLeave(bar('Guide sangle v2'));
    fireEvent.mouseEnter(card);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('queue-job-hover-card')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('queue-job-hover-card')).toBeNull();
  });

  it('says so when the job has no project and no client task', () => {
    renderWithLinked([running, pending(8, 'Ball.gcode.3mf', 1, HOUR)]);
    fireEvent.mouseEnter(bar('Ball.gcode.3mf'));
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_DWELL_MS);
    });
    const card = screen.getByTestId('queue-job-hover-card');
    expect(card).toHaveTextContent('queue.timeline.card.noProject');
    expect(card).toHaveTextContent('queue.timeline.card.noTask');
  });

  it('shows the running job as printing with its progress', () => {
    renderWithLinked();
    fireEvent.mouseEnter(bar('Running now'));
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_DWELL_MS);
    });
    expect(screen.getByTestId('queue-job-hover-card')).toHaveTextContent('queue.timeline.card.printing · 50%');
  });
});
