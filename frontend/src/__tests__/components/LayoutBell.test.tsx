/**
 * Where the notification bell sits in the Layout, and what it replaced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { Layout } from '../../components/Layout';
import { setAuthToken } from '../../api/client';

describe('Layout notification bell', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/version', () => HttpResponse.json({ version: '0.1.6', build: 'test' })),
      http.get('/api/v1/settings/ui-flags', () =>
        HttpResponse.json({ check_updates: false, billing_enabled: false, user_notifications_enabled: true }),
      ),
      http.get('/api/v1/inbox', () => HttpResponse.json({ items: [], unread: 3 })),
      http.get('/api/v1/inbox/preferences', () =>
        HttpResponse.json({ kinds: ['aito.paid'], sound_kinds: [], auto_watch: true, available: [] }),
      ),
    );
  });

  afterEach(() => {
    setAuthToken(null);
  });

  function signIn() {
    server.use(
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('/api/v1/auth/me', () =>
        HttpResponse.json({
          id: 1,
          username: 'admin',
          role: 'admin',
          is_active: true,
          is_admin: true,
          groups: [],
          permissions: [],
          created_at: '2026-01-01T00:00:00Z',
        }),
      ),
    );
    setAuthToken('test-token');
  }

  it('is the first icon of the sidebar row for a signed-in user', async () => {
    signIn();
    render(<Layout />);
    const bell = await screen.findByTestId('notification-bell');
    expect(bell.closest('aside')).not.toBeNull();
    expect(bell.parentElement?.firstElementChild).toBe(bell);
    expect(screen.getAllByTestId('notification-bell')).toHaveLength(1);
  });

  it('is absent without a signed-in user', async () => {
    render(<Layout />);
    await waitFor(() => expect(document.querySelector('aside')).toBeInTheDocument());
    expect(screen.queryByTestId('notification-bell')).toBeNull();
  });

  it('no longer links to GitHub', async () => {
    signIn();
    render(<Layout />);
    await screen.findByTestId('notification-bell');
    expect(document.querySelector('a[href*="github.com"]')).toBeNull();
  });
});
