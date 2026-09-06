import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { DueDateControl } from '../../components/aito/DueDateControl';
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
  shipping_service_name: null,
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
