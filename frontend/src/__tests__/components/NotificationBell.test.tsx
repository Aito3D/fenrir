/**
 * The notification bell: badge, panel, rows, deep links, arrival ring + chime.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { setAuthToken, type InboxItem, type InboxPreferences } from '../../api/client';
import { NotificationBell } from '../../components/NotificationBell';
import { chime, unlockChime } from '../../utils/chime';

vi.mock('../../utils/chime', () => ({ chime: vi.fn(), unlockChime: vi.fn(() => () => {}) }));

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const row = (patch: Partial<InboxItem>): InboxItem => ({
  id: 1,
  kind: 'aito.paid',
  family: 'aito',
  title: 'aito.paid',
  body: 'ACME · #41',
  target_type: 'aito_project',
  target_id: 41,
  created_at: ago(5),
  read_at: null,
  ...patch,
});

const AITO_KINDS = ['aito.quote_viewed', 'aito.quote_accepted', 'aito.quote_declined', 'aito.paid'];

const prefs = (patch: Partial<InboxPreferences> = {}): InboxPreferences => ({
  kinds: AITO_KINDS,
  sound_kinds: AITO_KINDS,
  auto_watch: true,
  available: [],
  ...patch,
});

let inbox: { items: InboxItem[]; unread: number };
let preferences: InboxPreferences;
const calls: string[] = [];
let putBody: unknown = null;
let prefsServed = false;

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

async function openPanel() {
  fireEvent.click(await screen.findByTestId('notification-bell'));
  return screen.findByRole('dialog');
}

describe('NotificationBell', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    calls.length = 0;
    putBody = null;
    prefsServed = false;
    inbox = {
      items: [
        row({ id: 12, kind: 'aito.quote_accepted', title: 'aito.quote_accepted', body: 'PACIFIC · #33' }),
        row({ id: 11, kind: 'aito.paid', title: 'aito.paid', body: 'ACME · #41', target_id: 41, created_at: ago(30) }),
        row({ id: 10, kind: 'aito.quote_viewed', title: 'aito.quote_viewed', read_at: ago(60), created_at: ago(120) }),
      ],
      unread: 2,
    };
    preferences = prefs();
    server.use(
      http.get('/api/v1/inbox', () => HttpResponse.json(inbox)),
      http.get('/api/v1/inbox/preferences', () => {
        prefsServed = true;
        return HttpResponse.json(preferences);
      }),
      http.put('/api/v1/inbox/preferences', async ({ request }) => {
        putBody = await request.json();
        preferences = { ...preferences, ...(putBody as object) };
        return HttpResponse.json(preferences);
      }),
      http.post('/api/v1/inbox/read-all', () => {
        calls.push('read-all');
        return new HttpResponse(null, { status: 204 });
      }),
      http.post('/api/v1/inbox/:id/read', ({ params }) => {
        calls.push(`read:${params.id}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );
  });

  afterEach(() => {
    setAuthToken(null);
  });

  it('is hidden when auth is enabled but nobody is signed in', async () => {
    server.use(
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    );
    render(<NotificationBell />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId('notification-bell')).toBeNull();
  });

  it('is hidden when auth is disabled', async () => {
    render(<NotificationBell />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId('notification-bell')).toBeNull();
  });

  it('shows the unread count from the response, capped at 9+', async () => {
    signIn();
    inbox.unread = 14;
    render(<NotificationBell />);
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('9+');
  });

  it('lists rows newest first with the kind title from i18n', async () => {
    signIn();
    render(<NotificationBell />);
    expect(await screen.findByTestId('notification-badge')).toHaveTextContent('2');
    const dialog = await openPanel();
    const rows = within(dialog).getAllByTestId(/^notification-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'notification-row-12',
      'notification-row-11',
      'notification-row-10',
    ]);
    expect(rows[0]).toHaveTextContent('Quote accepted');
    expect(rows[0]).toHaveTextContent('PACIFIC · #33');
    expect(rows[1]).toHaveTextContent('Payment received');
    expect(within(dialog).getByText('2 unread')).toBeInTheDocument();
  });

  it('a row click marks it read and opens its card', async () => {
    signIn();
    render(<NotificationBell />);
    const dialog = await openPanel();
    fireEvent.click(within(dialog).getByTestId('notification-row-11'));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/aito?card=41'));
    await waitFor(() => expect(calls).toEqual(['read:11']));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a row whose target is gone opens the family page and says so', async () => {
    signIn();
    inbox.items[1] = { ...inbox.items[1], target_id: null };
    render(<NotificationBell />);
    const dialog = await openPanel();
    fireEvent.click(within(dialog).getByTestId('notification-row-11'));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/aito'));
    expect(await screen.findByText('That item no longer exists')).toBeInTheDocument();
  });

  it('the unread dot marks read without leaving, and updates the badge at once', async () => {
    signIn();
    let answer: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.use(
      http.post('/api/v1/inbox/:id/read', async ({ params }) => {
        calls.push(`read:${params.id}`);
        await held;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<NotificationBell />);
    const dialog = await openPanel();
    fireEvent.click(within(dialog).getByTestId('notification-dot-12'));
    // Optimistic: the badge drops while the request is still held open.
    await waitFor(() => expect(screen.getByTestId('notification-badge')).toHaveTextContent('1'));
    await waitFor(() => expect(calls).toEqual(['read:12']));
    answer();
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('notification-dot-12')).toBeNull();
  });

  it('a failed mark-read says so and puts the row back from the server', async () => {
    signIn();
    let served = 0;
    server.use(
      http.get('/api/v1/inbox', () => {
        served += 1;
        return HttpResponse.json(inbox);
      }),
      http.post('/api/v1/inbox/:id/read', () => HttpResponse.json({ detail: 'nope' }, { status: 500 })),
    );
    render(<NotificationBell />);
    const dialog = await openPanel();
    await within(dialog).findByTestId('notification-dot-12');
    const before = served;
    fireEvent.click(within(dialog).getByTestId('notification-dot-12'));
    expect(await screen.findByText("Couldn't mark it as read")).toBeInTheDocument();
    await waitFor(() => expect(served).toBeGreaterThan(before));
    // The refetch restores the server's truth: the row is unread again.
    expect(await within(dialog).findByTestId('notification-dot-12')).toBeInTheDocument();
    expect(screen.getByTestId('notification-badge')).toHaveTextContent('2');
  });

  it('is a modal dialog that takes focus on open and hands it back to the bell on close', async () => {
    signIn();
    render(<NotificationBell />);
    const dialog = await openPanel();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('notification-bell'));
  });

  it('is 24rem wide, from the root font size', async () => {
    signIn();
    const fontSize = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = '14.4px';
    try {
      render(<NotificationBell />);
      const dialog = await openPanel();
      // 24 × 14.4px, the app's root rem: not a hard 384px.
      expect(dialog.style.width).toBe(`${24 * 14.4}px`);
    } finally {
      document.documentElement.style.fontSize = fontSize;
    }
  });

  it('installs the chime unlock when it mounts', async () => {
    signIn();
    vi.mocked(unlockChime).mockClear();
    render(<NotificationBell />);
    await screen.findByTestId('notification-bell');
    expect(unlockChime).toHaveBeenCalled();
  });

  describe('placement beside the sidebar', () => {
    const rect = (r: { top: number; bottom: number; left: number; right: number }) =>
      ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r }) as DOMRect;

    function mockRects(asideRight: number) {
      return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.tagName === 'ASIDE') return rect({ top: 0, bottom: 768, left: 0, right: asideRight });
        if (this.dataset.testid === 'notification-bell') return rect({ top: 600, bottom: 640, left: 20, right: 60 });
        return rect({ top: 0, bottom: 0, left: 0, right: 0 });
      });
    }

    it("starts at the expanded sidebar's right edge, not the bell's", async () => {
      signIn();
      const spy = mockRects(256);
      try {
        render(
          <aside>
            <NotificationBell />
          </aside>,
        );
        const dialog = await openPanel();
        expect(dialog.style.left).toBe(`${256 + 12}px`);
        expect(dialog.style.bottom).toBe(`${window.innerHeight - 640}px`);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps the bell anchor when the bell is not inside a sidebar', async () => {
      signIn();
      const spy = mockRects(256);
      try {
        render(<NotificationBell />);
        const dialog = await openPanel();
        expect(dialog.style.left).toBe(`${60 + 12}px`);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('Mark all read clears every unread row', async () => {
    signIn();
    render(<NotificationBell />);
    const dialog = await openPanel();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(calls).toEqual(['read-all']));
    expect(screen.queryByTestId('notification-badge')).toBeNull();
    expect(within(dialog).queryByTestId(/^notification-dot-/)).toBeNull();
  });

  it('Escape closes the panel', async () => {
    signIn();
    render(<NotificationBell />);
    await openPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the sound toggle writes all-or-none sound kinds', async () => {
    signIn();
    render(<NotificationBell />);
    const dialog = await openPanel();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Sound on' }));
    await waitFor(() => expect(putBody).toEqual({ kinds: AITO_KINDS, sound_kinds: [], auto_watch: true }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Sound off' }));
    await waitFor(() => expect(putBody).toEqual({ kinds: AITO_KINDS, sound_kinds: AITO_KINDS, auto_watch: true }));
  });

  it('hides the family chips when only one family is enabled', async () => {
    signIn();
    render(<NotificationBell />);
    const dialog = await openPanel();
    await screen.findByTestId('notification-row-12');
    expect(within(dialog).queryByRole('button', { name: 'All' })).toBeNull();
  });

  it('filters by family when both families are enabled', async () => {
    signIn();
    preferences = prefs({ kinds: [...AITO_KINDS, 'printer.finished'] });
    inbox.items.unshift(
      row({ id: 13, kind: 'printer.finished', family: 'printer', title: 'printer.finished', target_type: 'printer', target_id: 3 }),
    );
    render(<NotificationBell />);
    const dialog = await openPanel();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Printers' }));
    expect(within(dialog).getAllByTestId(/^notification-row-/).map((r) => r.dataset.testid)).toEqual([
      'notification-row-13',
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'All' }));
    expect(within(dialog).getAllByTestId(/^notification-row-/)).toHaveLength(4);
  });

  describe('arrival', () => {
    async function refetchWith(next: InboxItem) {
      inbox = { items: [next, ...inbox.items], unread: inbox.unread + 1 };
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
    }

    afterEach(() => {
      focusManager.setFocused(undefined);
    });

    it('rings and chimes when a newer unread row has a ringing kind', async () => {
      signIn();
      render(<NotificationBell />);
      const bell = await screen.findByTestId('notification-bell');
      await screen.findByTestId('notification-badge');
      // Wait for preferences too: the chime decision reads them.
      await waitFor(() => expect(prefsServed).toBe(true));
      expect(bell.querySelector('.bell-ring')).toBeNull();
      expect(chime).not.toHaveBeenCalled();

      await refetchWith(row({ id: 20, kind: 'aito.paid', title: 'aito.paid' }));

      await waitFor(() => expect(screen.getByTestId('notification-badge')).toHaveTextContent('3'));
      expect(bell.querySelector('.bell-ring')).not.toBeNull();
      expect(chime).toHaveBeenCalledTimes(1);
    });

    it('rings without a chime when the kind is not in sound_kinds', async () => {
      signIn();
      preferences = prefs({ sound_kinds: ['aito.quote_accepted'] });
      render(<NotificationBell />);
      const bell = await screen.findByTestId('notification-bell');
      await screen.findByTestId('notification-badge');
      await waitFor(() => expect(prefsServed).toBe(true));

      await refetchWith(row({ id: 20, kind: 'aito.paid', title: 'aito.paid' }));

      await waitFor(() => expect(screen.getByTestId('notification-badge')).toHaveTextContent('3'));
      expect(bell.querySelector('.bell-ring')).not.toBeNull();
      expect(chime).not.toHaveBeenCalled();
    });
  });
});
