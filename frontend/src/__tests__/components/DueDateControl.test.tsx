import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { render } from '../utils';
import { DueDateControl } from '../../components/aito/DueDateControl';
import { addWorkingDays, localDateKey, parseLocalDateKey } from '../../utils/date';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

// Same full-project posture as FlagControl.test.tsx: the optimistic layer
// rewrites the board cache row, so the component needs a real AitoProject.
const baseProject: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: null,
  client_email: null,
  client_is_company: null,
  client_social_network: null,
  client_social_handle: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sent_at: null,
  invoice_status: null,
  invoice_balance: null,
  invoice_due_date: null,
  invoice_checked_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
  client_contacted_at: null,
  due_date: null,
  quote_sync_error: null,
  quote_status_block: null,
  quote_status_remote: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  task_pending: [],
  steps_total: 0,
  steps_done: 0,
  print_minutes_pending: 0,
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_lta: null,
  shipping_service_name: null,
  tracking_url: null,
  tracking_configured: false,
  version: 1,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = fineMatchMedia;
});

// The setup file's matchMedia matches nothing, which is a fine pointer as far
// as the control is concerned. Tests that want a phone swap in this one.
const fineMatchMedia = window.matchMedia;
function pretendCoarsePointer() {
  window.matchMedia = (query: string) => ({ ...fineMatchMedia(query), matches: query === '(pointer: coarse)' });
}

const suggestion = () => addWorkingDays(new Date(), 2);
const cellName = (key: string) =>
  parseLocalDateKey(key).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
const pill = () => screen.getByRole('button', { name: /set a date/i });
const stat = () => screen.getByRole('button', { name: /promised date/i });
const picker = () => screen.getByRole('dialog', { name: /promised date/i });


describe('DueDateControl', () => {
  it('offers one action when nothing is promised: a Set-a-date pill', () => {
    // No em dash over a helper line — the pill is the whole empty state, and
    // it is a button, so it reads as the thing to press.
    render(<DueDateControl project={baseProject} />);
    expect(pill()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('due-date-value')).not.toBeInTheDocument();
    expect(screen.getByTestId('due-date-control')).toHaveAttribute('data-due-level', 'none');
  });

  it('opens the in-page picker on the suggestion two working days out, without promising anything', async () => {
    // The browser would open on today, which is the one day the answer is
    // never. The suggestion is where focus lands — outlined, not filled —
    // and no PATCH goes out until a day is actually picked.
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue(baseProject);
    render(<DueDateControl project={baseProject} />);
    fireEvent.click(pill());
    expect(picker()).toBeInTheDocument();
    expect(pill()).toHaveAttribute('aria-expanded', 'true');
    const suggested = screen.getByRole('gridcell', { name: new RegExp(`${cellName(suggestion())} \\(suggested\\)`) });
    expect(suggested).toHaveFocus();
    expect(suggested).toHaveAttribute('aria-selected', 'false');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).not.toHaveBeenCalled();
  });

  it('suggests a weekday: two working days from a Friday is Tuesday', () => {
    // The rule the user asked for, pinned through the component rather than
    // only through `addWorkingDays`, so wiring the wrong helper here fails.
    // shouldAdvanceTime, so React's own scheduling still runs under the
    // frozen clock rather than deadlocking on a timer that never fires.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 4, 9, 0, 0)); // Friday 2026-09-04
    render(<DueDateControl project={baseProject} />);
    fireEvent.click(pill());
    expect(screen.getByRole('gridcell', { name: /Sep 8, 2026 \(suggested\)/ })).toHaveFocus();
    vi.useRealTimers();
  });

  it('saves a picked day through the due-date route, closes, and hands focus to the stat', async () => {
    const key = suggestion();
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue({ ...baseProject, due_date: key });
    const { rerender } = render(<DueDateControl project={baseProject} />);
    fireEvent.click(pill());
    fireEvent.click(screen.getByRole('gridcell', { name: new RegExp(cellName(key)) }));
    // `waitFor` absorbs useOptimisticBoardMutation's own microtask chain
    // (onMutate awaits cancelQueries before mutationFn runs) — same reason
    // AitoQuoteStatusActions.test.tsx waits rather than asserting inline.
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, key));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The board row comes back with the date; the trigger is now the stat,
    // and that is what takes the focus the picker gave up.
    rerender(<DueDateControl project={{ ...baseProject, due_date: key }} />);
    expect(stat()).toHaveFocus();
  });

  it('lands the new value after a change, but never on the panel\'s first paint', () => {
    // The panel has its own entrance; a countdown that also dropped in on
    // open would be two motions for one event. After a pick the value is
    // new information, and that is what drops in — the pill too, on a clear.
    const { rerender } = render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} />);
    expect(screen.getByTestId('due-date-value')).not.toHaveClass('animate-aito-due-land');
    rerender(<DueDateControl project={{ ...baseProject, due_date: '2026-09-19' }} />);
    expect(screen.getByTestId('due-date-value')).toHaveClass('animate-aito-due-land');
    // A re-render with the same date keeps the class on the same element, so
    // nothing replays; only a new value mounts a new one.
    rerender(<DueDateControl project={{ ...baseProject, due_date: '2026-09-19' }} />);
    expect(screen.getByTestId('due-date-value')).toHaveClass('animate-aito-due-land');
    rerender(<DueDateControl project={baseProject} />);
    expect(pill()).toHaveClass('animate-aito-due-land');
  });

  it('opens the pill without a landing when nothing was ever promised', () => {
    render(<DueDateControl project={baseProject} />);
    expect(pill()).not.toHaveClass('animate-aito-due-land');
  });

  it('reopens from the stat and clears from the picker', async () => {
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue({ ...baseProject, due_date: null });
    render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} />);
    expect(screen.queryByRole('button', { name: /clear the date/i })).not.toBeInTheDocument();
    fireEvent.click(stat());
    expect(screen.getByRole('gridcell', { name: 'Sep 12, 2026' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, null));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not call the API when the picker is re-picked to the stored date', async () => {
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue(baseProject);
    render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} />);
    fireEvent.click(stat());
    fireEvent.click(screen.getByRole('gridcell', { name: 'Sep 12, 2026' }));
    // A negative needs a beat: the mutation's own onMutate awaits
    // cancelQueries, so an inline assertion would pass even if the call HAD
    // been made. One macrotask is past that microtask chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to the trigger', () => {
    render(<DueDateControl project={baseProject} />);
    fireEvent.click(pill());
    fireEvent.keyDown(picker(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(pill()).toHaveFocus();
  });

  it('closes on a press outside, and a press on the trigger toggles rather than reopens', () => {
    render(<DueDateControl project={baseProject} />);
    fireEvent.click(pill());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(pill());
    expect(picker()).toBeInTheDocument();
    fireEvent.pointerDown(pill());
    fireEvent.click(pill());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reads the promise back as a formatted date under the countdown', () => {
    render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} />);
    expect(screen.getByTestId('due-date-date')).toHaveTextContent('Sep 12, 2026');
  });

  it('leads with the countdown, because that is the question a promise raises', () => {
    // Relative to today, not a fixed string: the stat is a countdown, so a
    // hard-coded "in 13d" would start failing the day after it was written.
    const in13 = new Date();
    in13.setDate(in13.getDate() + 13);
    render(<DueDateControl project={{ ...baseProject, due_date: localDateKey(in13) }} />);
    expect(screen.getByTestId('due-date-value')).toHaveTextContent('in 13d');
    expect(screen.getByTestId('due-date-control')).toHaveAttribute('data-due-level', 'far');
  });

  it('says a promise due today is due today, not "in 0 days"', () => {
    render(<DueDateControl project={{ ...baseProject, due_date: localDateKey(new Date()) }} />);
    expect(screen.getByTestId('due-date-value')).toHaveTextContent(/today/i);
    expect(screen.getByTestId('due-date-control')).toHaveAttribute('data-due-level', 'today');
  });

  it('carries the board ramp: a promise in the past is late, and red', () => {
    // Same `dueDateLevel` the card badge uses, so "late" is one colour across
    // the board and the panel rather than two components' private opinions.
    // "late", never "ago": a missed promise is not an event that happened.
    const late = new Date();
    late.setDate(late.getDate() - 3);
    render(<DueDateControl project={{ ...baseProject, due_date: localDateKey(late) }} />);
    expect(screen.getByTestId('due-date-control')).toHaveAttribute('data-due-level', 'past');
    expect(screen.getByTestId('due-date-value')).toHaveTextContent('3 d late');
    expect(screen.getByTestId('due-date-value')).toHaveClass('text-red-400');
  });

  it('shows a promise to a reader who may not edit it, without the controls', () => {
    // The date is information, not only a control: a viewer still needs to
    // know when the job was promised. What goes is the picker and the clear.
    render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} canUpdate={false} />);
    expect(screen.getByTestId('due-date-date')).toHaveTextContent('Sep 12, 2026');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  describe('on a coarse pointer', () => {
    // A phone keeps the OS picker: a transparent native input over the stat,
    // prefilled with the suggestion so the picker lands on a weekday, and an
    // always-visible clear, since there is no popover to clear from.
    it('keeps the native input, prefilled with the suggestion and saving on change', async () => {
      pretendCoarsePointer();
      const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue({ ...baseProject, due_date: '2026-09-12' });
      render(<DueDateControl project={baseProject} />);
      const input = await screen.findByLabelText(/promised date/i);
      expect(input).toHaveValue(suggestion());
      fireEvent.click(pill());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.change(input, { target: { value: '2026-09-12' } });
      await waitFor(() => expect(spy).toHaveBeenCalledWith(12, '2026-09-12'));
    });

    it('clears with the X and ignores the part-typed years a date input emits', async () => {
      pretendCoarsePointer();
      const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue({ ...baseProject, due_date: null });
      render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} />);
      const input = await screen.findByLabelText(/promised date/i);
      // Typing "2027" into the year field emits a change per digit, each one
      // a syntactically valid date. Only the last is a promise.
      for (const value of ['0002-09-12', '0020-09-12', '0202-09-12']) {
        fireEvent.change(input, { target: { value } });
      }
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(spy).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /clear the date/i }));
      await waitFor(() => expect(spy).toHaveBeenCalledWith(12, null));
    });
  });
});
