/**
 * Settings → Notifications → Inbox: per-user kinds, rings and auto-watch,
 * saved through one debounced PUT.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { setAuthToken, type InboxKindInfo, type InboxPreferences as Prefs } from '../../api/client';
import { InboxPreferences } from '../../components/settings/InboxPreferences';

const AVAILABLE: InboxKindInfo[] = [
  { kind: 'aito.quote_viewed', family: 'aito', default_on: true, available: true },
  { kind: 'aito.quote_accepted', family: 'aito', default_on: true, available: true },
  { kind: 'aito.quote_declined', family: 'aito', default_on: true, available: true },
  { kind: 'aito.paid', family: 'aito', default_on: true, available: true },
  { kind: 'aito.overdue', family: 'aito', default_on: false, available: true },
  { kind: 'printer.job_sent', family: 'printer', default_on: false, available: false },
  { kind: 'printer.finished', family: 'printer', default_on: false, available: false },
  { kind: 'printer.failed', family: 'printer', default_on: false, available: false },
];
const DEFAULTS = ['aito.quote_viewed', 'aito.quote_accepted', 'aito.quote_declined', 'aito.paid'];

let preferences: Prefs;
let puts: { kinds: string[]; sound_kinds: string[]; auto_watch: boolean }[];
let failPut: boolean;

function signIn() {
  server.use(
    http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 7,
        username: 'ops',
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [],
        permissions: [],
        created_at: '2026-01-01T00:00:00Z',
      }),
    ),
  );
  setAuthToken('test-token');
}

const sw = (name: string) => screen.getByRole('switch', { name });

/** Let the optimistic cache write reach the switches (query notifications are batched). */
async function rerender() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Past the 400 ms debounce, then let the PUT round-trip settle. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

async function mount() {
  render(<InboxPreferences />);
  await screen.findByRole('switch', { name: 'Payment received' });
}

describe('InboxPreferences', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    puts = [];
    failPut = false;
    preferences = { kinds: [...DEFAULTS], sound_kinds: [...DEFAULTS], auto_watch: true, available: AVAILABLE };
    signIn();
    server.use(
      http.get('/api/v1/inbox/preferences', () => HttpResponse.json(preferences)),
      http.put('/api/v1/inbox/preferences', async ({ request }) => {
        const body = (await request.json()) as (typeof puts)[number];
        puts.push(body);
        if (failPut) return HttpResponse.json({ detail: 'nope' }, { status: 500 });
        preferences = { ...preferences, ...body };
        return HttpResponse.json(preferences);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    setAuthToken(null);
  });

  it('renders both families with their kinds, says it is per user', async () => {
    await mount();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
    expect(screen.getByText('These settings are yours only.')).toBeInTheDocument();
    expect(sw('Aito')).toHaveAttribute('aria-checked', 'true');
    expect(sw('Printers')).toHaveAttribute('aria-checked', 'false');
    expect(sw('Quote accepted')).toHaveAttribute('aria-checked', 'true');
    expect(sw('Promised date passed')).toHaveAttribute('aria-checked', 'false');
    expect(sw('Ring: Quote accepted')).toHaveAttribute('aria-checked', 'true');
    // A kind that is off cannot ring.
    expect(sw('Ring: Promised date passed')).toBeDisabled();
    expect(sw('Print finished')).toBeInTheDocument();
  });

  it('printer kinds are tagged coming later, off and disabled', async () => {
    await mount();
    expect(screen.getAllByText('Coming later')).toHaveLength(3);
    for (const name of ['Job sent to printer', 'Print finished', 'Print failed']) {
      expect(sw(name)).toBeDisabled();
      expect(sw(name)).toHaveAttribute('aria-checked', 'false');
      expect(sw(`Ring: ${name}`)).toBeDisabled();
    }
    expect(sw('Printers')).toBeDisabled();
  });

  it('a burst of two kind toggles sends one debounced PUT', async () => {
    await mount();
    fireEvent.click(sw('Quote opened by the client'));
    fireEvent.click(sw('Promised date passed'));
    await rerender();
    // Optimistic: the switches move before anything is saved.
    expect(sw('Quote opened by the client')).toHaveAttribute('aria-checked', 'false');
    expect(sw('Promised date passed')).toHaveAttribute('aria-checked', 'true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(puts).toHaveLength(0);
    await settle();
    expect(puts).toHaveLength(1);
    expect([...puts[0].kinds].sort()).toEqual(
      ['aito.overdue', 'aito.paid', 'aito.quote_accepted', 'aito.quote_declined'].sort(),
    );
    // Turning a kind off silences it too.
    expect(puts[0].sound_kinds).not.toContain('aito.quote_viewed');
    expect(puts[0].auto_watch).toBe(true);
  });

  it('turning a family off unticks its kinds and their rings', async () => {
    await mount();
    fireEvent.click(sw('Aito'));
    await rerender();
    for (const name of ['Quote opened by the client', 'Quote accepted', 'Payment received']) {
      expect(sw(name)).toHaveAttribute('aria-checked', 'false');
      expect(sw(`Ring: ${name}`)).toHaveAttribute('aria-checked', 'false');
    }
    await settle();
    expect(puts).toEqual([{ kinds: [], sound_kinds: [], auto_watch: true }]);
  });

  it('turning a family back on restores its default kinds', async () => {
    preferences = { ...preferences, kinds: [], sound_kinds: [] };
    await mount();
    fireEvent.click(sw('Aito'));
    await settle();
    expect([...puts[0].kinds].sort()).toEqual([...DEFAULTS].sort());
    expect(puts[0].kinds).not.toContain('aito.overdue');
  });

  it('a ring toggle changes sound_kinds only', async () => {
    await mount();
    fireEvent.click(sw('Ring: Payment received'));
    await rerender();
    expect(sw('Ring: Payment received')).toHaveAttribute('aria-checked', 'false');
    await settle();
    expect(puts).toHaveLength(1);
    expect(puts[0].kinds).toEqual(DEFAULTS);
    expect(puts[0].sound_kinds).toEqual(['aito.quote_viewed', 'aito.quote_accepted', 'aito.quote_declined']);
  });

  it('the auto-watch switch PUTs auto_watch', async () => {
    await mount();
    const autoWatch = sw('Auto-watch cards I create');
    expect(autoWatch).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(autoWatch);
    await settle();
    expect(puts).toEqual([{ kinds: DEFAULTS, sound_kinds: DEFAULTS, auto_watch: false }]);
  });

  it('a failed save toasts and puts the saved state back', async () => {
    failPut = true;
    await mount();
    fireEvent.click(sw('Payment received'));
    await rerender();
    expect(sw('Payment received')).toHaveAttribute('aria-checked', 'false');
    await settle();
    expect(await screen.findByText('Could not save your inbox settings')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(sw('Payment received')).toHaveAttribute('aria-checked', 'true');
  });

  it('renders nothing without a signed-in user', async () => {
    setAuthToken(null);
    server.use(http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })));
    render(<InboxPreferences />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.queryByText('Inbox')).toBeNull();
  });
});
