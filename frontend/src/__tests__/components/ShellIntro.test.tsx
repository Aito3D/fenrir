/**
 * Tests for shell intro gating: the Layout entrance animation should play
 * only on the first mount per JS session, and replay after armShellIntro()
 * (the login path).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { render } from '../utils';
import { Layout, armShellIntro } from '../../components/Layout';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

function renderLayout() {
  return render(<Layout />);
}

describe('shell intro gating', () => {
  beforeEach(() => {
    armShellIntro(); // reset module state between tests

    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.mocked(localStorage.removeItem).mockReset();
    vi.mocked(localStorage.clear).mockReset();
    localStorage.clear();
    server.use(
      http.get('/api/v1/printers/', () => {
        return HttpResponse.json([
          { id: 1, name: 'X1 Carbon', model: 'X1C', enabled: true },
        ]);
      }),
      http.get('/api/v1/printers/:id/status', () => {
        return HttpResponse.json({
          connected: true,
          state: 'IDLE',
        });
      }),
      http.get('/api/v1/version', () => {
        return HttpResponse.json({ version: '0.1.6', build: 'test' });
      }),
      http.get('/api/v1/settings/', () => {
        return HttpResponse.json({
          check_updates: false,
          check_printer_firmware: false,
          auto_archive: true,
        });
      }),
      http.get('/api/v1/external-links/', () => {
        return HttpResponse.json([]);
      }),
      http.get('/api/v1/smart-plugs/', () => {
        return HttpResponse.json([]);
      }),
      http.get('/api/v1/support/debug-logging', () => {
        return HttpResponse.json({ enabled: false });
      }),
      http.get('/api/v1/queue/', () => {
        return HttpResponse.json([]);
      }),
      http.get('/api/v1/pending-uploads/count', () => {
        return HttpResponse.json({ count: 0 });
      }),
      http.get('/api/v1/updates/check', () => {
        return HttpResponse.json({ update_available: false });
      }),
      http.get('/api/v1/auth/status', () => {
        return HttpResponse.json({ auth_enabled: false, requires_setup: false });
      }),
      http.get('/api/v1/printers/developer-mode-warnings', () => {
        return HttpResponse.json([]);
      })
    );
  });

  it('plays the intro on the first Layout mount of a session', async () => {
    const { container } = renderLayout();
    await waitFor(() => {
      expect(
        container.querySelector('.animate-sidebar-in, .animate-topbar-in')
      ).not.toBeNull();
    });
  });

  it('does not replay the intro on a second mount in the same session', async () => {
    const first = renderLayout();
    await waitFor(() =>
      expect(first.container.querySelector('aside, header')).not.toBeNull()
    );
    first.unmount();

    const second = renderLayout();
    await waitFor(() =>
      expect(second.container.querySelector('aside, header')).not.toBeNull()
    );
    expect(second.container.querySelector('.animate-sidebar-in')).toBeNull();
    expect(second.container.querySelector('.animate-topbar-in')).toBeNull();
    expect(second.container.querySelector('.stagger-fade-in')).toBeNull();
  });

  it('replays the intro after armShellIntro() (login path)', async () => {
    const first = renderLayout();
    await waitFor(() =>
      expect(first.container.querySelector('aside, header')).not.toBeNull()
    );
    first.unmount();

    armShellIntro();
    const second = renderLayout();
    await waitFor(() => {
      expect(
        second.container.querySelector('.animate-sidebar-in, .animate-topbar-in')
      ).not.toBeNull();
    });
  });
});
