/**
 * `TrackingLinkControl` — Copy / Regenerate for the card's public tracking
 * link, mounted in `ProjectDetailPanel`'s contact row.
 *
 * The hold-completion incantation (fake timers + `userEvent.pointer`) is
 * copied from `AitoQuoteStatusActions.test.tsx`'s `holdButton` helper, which
 * exercises the same `HoldButton` through a real 500ms hold — the task
 * brief's own suggestion to mirror `AitoHoldButton.test.tsx` doesn't fit
 * here, since that file drives `HoldButton` with `fireEvent.pointerDown` +
 * `vi.advanceTimersByTime` directly and never resolves a real mutation
 * (msw) in between; `userEvent.pointer` + `shouldAdvanceTime: true` lets the
 * request's promise chain actually progress.
 *
 * `makeProject` is copied from `AitoQuoteStatusActions.test.tsx` (not
 * `ProjectDetailPanel.test.tsx`, which has no such helper — only a single
 * inline fixture object).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { TrackingLinkControl } from '../../components/aito/TrackingLinkControl';
import type { AitoProject } from '../../api/client';

// Mirrors AitoQuoteStatusActions.test.tsx's `makeProject`: every field the
// board cache needs, defaulted so a test overrides only what it cares about.
function makeProject(overrides: Partial<AitoProject> = {}): AitoProject {
  const base: AitoProject = {
    id: 1,
    description: 'Support de caméra',
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: 'z1',
    client_name: 'ACME SARL',
    client_phone: '+689-87123456',
    client_email: 'hi@acme.pf',
    client_is_company: null,
    client_social_network: null,
    client_social_handle: null,
    quote_id: 'EST-1',
    quote_number: null,
    quote_date: null,
    quote_total: null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: 'draft',
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
  return { ...base, ...overrides };
}

const project = makeProject({ id: 7, tracking_url: null, tracking_configured: true });

beforeEach(() => {
  // `copyTextToClipboard` only takes the `navigator.clipboard` branch inside
  // a secure context; jsdom's default `http://localhost:3000` test origin
  // (vitest.config.ts) is not one, so `isSecureContext` has to be forced —
  // see `clipboard.test.ts` and `PrinterInfoModal.test.tsx` for the same
  // pattern.
  vi.stubGlobal('isSecureContext', true);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Holds a button through HoldButton's confirm delay under fake timers,
 *  copied from AitoQuoteStatusActions.test.tsx's `holdButton` helper. */
async function holdButton(button: HTMLElement) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.pointer({ keys: '[MouseLeft>]', target: button });
  vi.advanceTimersByTime(600);
}

describe('TrackingLinkControl', () => {
  it('copies the link from the link endpoint', async () => {
    server.use(
      http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: 'https://x.pf/track/abc' })),
    );
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://x.pf/track/abc'));
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it('is disabled with a settings hint when the external URL is not configured', () => {
    render(<TrackingLinkControl project={{ ...project, tracking_configured: false }} />);
    expect(screen.getByRole('button', { name: /copy tracking link/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/settings?tab=network');
  });

  it('regenerates on a completed hold and toasts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    server.use(
      http.post('/api/v1/aito/7/tracking-token', () => {
        calls.push('regen');
        return HttpResponse.json({ tracking_url: 'https://x.pf/track/new' });
      }),
    );
    render(<TrackingLinkControl project={project} />);

    await holdButton(screen.getByRole('button', { name: /new tracking link/i }));

    await waitFor(() => expect(calls).toEqual(['regen']));
    expect(await screen.findByText(/new tracking link/i)).toBeInTheDocument();
    vi.useRealTimers();
  });
});
