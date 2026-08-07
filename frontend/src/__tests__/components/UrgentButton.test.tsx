import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import { render } from '../utils';
import { UrgentButton } from '../../components/aito/UrgentButton';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

// A project with every field the board cache needs, defaulted so a test can
// override only what it cares about — mirrors AitoQuoteStatusActions.test.tsx's
// `makeProject`, since `UrgentButton` (like `QuoteStatusActions`) needs a full
// `AitoProject`, not just the `flag` field it reads.
const baseProject: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
  client_is_company: true,
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
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
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
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_service_name: null,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

describe('UrgentButton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires at 500ms and not before', async () => {
    vi.useFakeTimers();
    const setUrgent = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<UrgentButton project={{ ...baseProject, flag: null }} />);

    fireEvent.pointerDown(screen.getByRole('button'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(setUrgent).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(setUrgent).toHaveBeenCalledWith(baseProject.id, 'urgent');
  });

  it('does not toggle on a short tap', async () => {
    vi.useFakeTimers();
    const setUrgent = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<UrgentButton project={{ ...baseProject, flag: null }} />);

    const button = screen.getByRole('button');
    fireEvent.pointerDown(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.pointerUp(button);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(setUrgent).not.toHaveBeenCalled();
  });

  it('sends null when the project is already urgent', async () => {
    vi.useFakeTimers();
    const setUrgent = vi.spyOn(api, 'setAitoProjectFlag').mockResolvedValue({} as AitoProject);
    render(<UrgentButton project={{ ...baseProject, flag: 'urgent' }} />);

    fireEvent.pointerDown(screen.getByRole('button'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(setUrgent).toHaveBeenCalledWith(baseProject.id, null);
  });
});
