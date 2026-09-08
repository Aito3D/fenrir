import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { DueDateControl } from '../../components/aito/DueDateControl';
import { addWorkingDays, localDateKey } from '../../utils/date';
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

afterEach(() => vi.restoreAllMocks());

describe('DueDateControl', () => {
  it('saves a picked date through the due-date route', async () => {
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue({ ...baseProject, due_date: '2026-09-12' });
    render(<DueDateControl project={baseProject} />);
    expect(screen.queryByRole('button', { name: /clear the date/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/promised date/i), { target: { value: '2026-09-12' } });
    // `waitFor` absorbs useOptimisticBoardMutation's own microtask chain
    // (onMutate awaits cancelQueries before mutationFn runs) — same reason
    // AitoQuoteStatusActions.test.tsx waits rather than asserting inline.
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, '2026-09-12'));
  });

  it('shows the stored date and clears it with null', async () => {
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue({ ...baseProject, due_date: null });
    render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} />);
    expect(screen.getByLabelText(/promised date/i)).toHaveValue('2026-09-12');
    fireEvent.click(screen.getByRole('button', { name: /clear the date/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, null));
  });

  it('does not call the API when the picker is re-picked to the stored date', async () => {
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue(baseProject);
    render(<DueDateControl project={{ ...baseProject, due_date: '2026-09-12' }} />);
    fireEvent.change(screen.getByLabelText(/promised date/i), { target: { value: '2026-09-12' } });
    // A negative needs a beat: the mutation's own onMutate awaits
    // cancelQueries, so an inline assertion would pass even if the call HAD
    // been made. One macrotask is past that microtask chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads the promise back as a formatted date, not as the browser field', () => {
    // The native input is still there — it is the picker — but at opacity 0
    // over the stat. What the operator reads is this, and it is the whole
    // point of the overlay: the field itself renders "mm/dd/yyyy".
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

  it('opens the picker two working days out, without promising anything', async () => {
    // The browser would open an empty date field on today, which is the one
    // day the answer is never. The suggestion lives in the input — so the
    // picker lands on it — while the stat still reads "—" and "Set a date",
    // and no PATCH goes out until a day is actually picked.
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue(baseProject);
    render(<DueDateControl project={baseProject} />);
    expect(screen.getByLabelText(/promised date/i)).toHaveValue(addWorkingDays(new Date(), 2));
    expect(screen.getByTestId('due-date-value')).toHaveTextContent('—');
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
    expect(screen.getByLabelText(/promised date/i)).toHaveValue('2026-09-08');
    vi.useRealTimers();
  });

  it('asks for a date when none is set', () => {
    render(<DueDateControl project={baseProject} />);
    expect(screen.getByTestId('due-date-value')).toHaveTextContent('—');
    expect(screen.getByTestId('due-date-empty')).toHaveTextContent(/set a date/i);
    expect(screen.getByTestId('due-date-control')).toHaveAttribute('data-due-level', 'none');
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
    expect(screen.queryByLabelText(/promised date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear the date/i })).not.toBeInTheDocument();
  });

  it('ignores the part-typed years a date input emits while a year is typed', async () => {
    // Typing "2026" into the year field emits a change per digit, each one a
    // syntactically valid date. Only the last is a promise; the rest would be
    // three extra PATCHes, three story events and a card drawn overdue.
    const spy = vi.spyOn(api, 'setAitoProjectDueDate').mockResolvedValue({ ...baseProject, due_date: '2026-09-12' });
    render(<DueDateControl project={baseProject} />);
    const input = screen.getByLabelText(/promised date/i);
    for (const value of ['0002-09-12', '0020-09-12', '0202-09-12', '2026-09-12']) {
      fireEvent.change(input, { target: { value } });
    }
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, '2026-09-12'));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
