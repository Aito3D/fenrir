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
 * `makeProject` is shared with `AitoQuoteStatusActions.test.tsx` via
 * `../fixtures/aitoProject` (not `ProjectDetailPanel.test.tsx`, which has no
 * such helper — only a single inline fixture object).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { TrackingLinkControl } from '../../components/aito/TrackingLinkControl';
import { makeProject } from '../fixtures/aitoProject';

const project = makeProject({ id: 7, tracking_configured: true });

// `holdButton` below calls `userEvent.setup(...)`, which — once a hold test
// runs — replaces jsdom's `navigator.clipboard` with its own getter-only
// stub (an own accessor property, not just the prototype's). A later
// `Object.assign(navigator, { clipboard: ... })` then throws ("Cannot set
// property clipboard of #<Navigator> which has only a getter") for every
// test that follows, because `Object.assign` does a plain `[[Set]]` rather
// than defining a fresh own property. Capturing and restoring the original
// descriptor around `Object.defineProperty` — PrinterInfoModal.test.tsx's
// pattern — undoes that stub after each test instead of accumulating it.
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  // `copyTextToClipboard` only takes the `navigator.clipboard` branch inside
  // a secure context; jsdom's default `http://localhost:3000` test origin
  // (vitest.config.ts) is not one, so `isSecureContext` has to be forced —
  // see `clipboard.test.ts` and `PrinterInfoModal.test.tsx` for the same
  // pattern.
  vi.stubGlobal('isSecureContext', true);
  // defineProperty, not Object.assign: after a user-event test navigator
  // exposes `clipboard` as a getter-only property, and assignment throws.
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
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
      http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ tracking_url: 'https://x.pf/t/abc' })),
    );
    render(<TrackingLinkControl project={project} />);
    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://x.pf/t/abc'));
    // The confirmation rises in with the panel's tick vocabulary, then
    // fades out before it unmounts instead of vanishing in one frame.
    const copied = await screen.findByTestId('tracking-copied');
    expect(copied).toHaveClass('animate-rise-sm');
    expect(screen.getByRole('button', { name: /copy tracking link/i }).querySelector('svg')).toHaveClass('animate-tick-in');
    await waitFor(() => expect(screen.getByTestId('tracking-copied')).toHaveClass('animate-fade-out-sm'), { timeout: 2500 });
    await waitFor(() => expect(screen.queryByTestId('tracking-copied')).not.toBeInTheDocument());
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
        return HttpResponse.json({ tracking_url: 'https://x.pf/t/new' });
      }),
    );
    render(<TrackingLinkControl project={project} />);

    await holdButton(screen.getByRole('button', { name: /new tracking link/i }));

    await waitFor(() => expect(calls).toEqual(['regen']));
    expect(await screen.findByText(/new tracking link/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('warns when the quote could not take the new link', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server.use(
      http.post('/api/v1/aito/7/tracking-token', () =>
        HttpResponse.json({ tracking_url: 'https://x.pf/t/new', quote_notes: 'failed' }),
      ),
    );
    render(<TrackingLinkControl project={project} />);
    await holdButton(screen.getByRole('button', { name: /new tracking link/i }));
    expect(await screen.findByText(/quote could not be updated/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('toasts an error and does not copy when the link endpoint fails', async () => {
    server.use(http.get('/api/v1/aito/7/tracking-link', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<TrackingLinkControl project={project} />);

    await userEvent.click(screen.getByRole('button', { name: /copy tracking link/i }));

    expect(await screen.findByText(/error loading data/i)).toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(screen.queryByText(/copied/i)).not.toBeInTheDocument();
  });

  it('toasts an error and does not regenerate when the token endpoint fails on a completed hold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls: string[] = [];
    server.use(
      http.post('/api/v1/aito/7/tracking-token', () => {
        calls.push('regen');
        return HttpResponse.json({ detail: 'boom' }, { status: 500 });
      }),
    );
    render(<TrackingLinkControl project={project} />);

    await holdButton(screen.getByRole('button', { name: /new tracking link/i }));

    await waitFor(() => expect(calls).toEqual(['regen']));
    expect(await screen.findByText(/error loading data/i)).toBeInTheDocument();
    expect(screen.queryByText(/new tracking link/i)).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
