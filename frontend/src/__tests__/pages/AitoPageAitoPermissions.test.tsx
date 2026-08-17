/**
 * AitoPage gates its board WRITE controls on aito:* permissions (T-019).
 *
 * The page itself carried zero permission checks: New project, Import quote
 * and the panel's delete control were always rendered, even for a signed-in
 * user the backend would 403 the moment they clicked (routes/aito.py enforces
 * Permission.AITO_CREATE / AITO_DELETE). This mirrors CalculatorPage's own
 * gating philosophy (`hasPermission` from useAuth) and only that: the board
 * itself (and its trash/done archives) stay ungated, matching how sibling
 * pages leave read access alone and only hide what the user could not
 * actually use.
 *
 * `hasPermission` returns true for everything when auth is disabled (see
 * AuthContext), so the first case below pins that a default single-user
 * install sees no difference at all.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true,
  requiresSetup: false,
  loading: false,
  isAdmin: false,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  refreshAuth: vi.fn(),
  hasPermission: vi.fn((_permission: string) => true),
  hasAnyPermission: vi.fn(() => true),
  hasAllPermissions: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';

const project = {
  id: 12,
  description: 'Support GoPro',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+33 6 12 34 56 78',
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
  version: 1,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
};

const openCard = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: /Support GoPro/ }));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mockUseAuth.hasPermission.mockReset();

  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([project])),
    http.delete('/api/v1/aito/:id', () => new HttpResponse(null, { status: 204 })),
  );
});

describe('AitoPage — aito:* permission gating (T-019)', () => {
  it('auth disabled: shows New project, Import quote and the delete control', async () => {
    mockUseAuth.authEnabled = false;
    mockUseAuth.hasPermission.mockImplementation(() => true); // AuthContext semantics: auth disabled = allow all

    const user = userEvent.setup();
    render(<AitoPage />);

    expect(await screen.findByRole('button', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();

    await openCard(user);
    expect(await screen.findByLabelText('Move to trash')).toBeInTheDocument();
  });

  it('auth enabled + every aito permission granted: shows New project, Import quote and the delete control', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) =>
      ['aito:read', 'aito:create', 'aito:update', 'aito:delete'].includes(permission),
    );

    const user = userEvent.setup();
    render(<AitoPage />);

    expect(await screen.findByRole('button', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();

    await openCard(user);
    expect(await screen.findByLabelText('Move to trash')).toBeInTheDocument();
  });

  it('auth enabled + read-only (aito:read only): hides New project, Import quote and the delete control', async () => {
    mockUseAuth.authEnabled = true;
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');

    const user = userEvent.setup();
    render(<AitoPage />);

    // The board itself is not gated — a read-only user still sees their work,
    // just none of the controls that would only 403.
    expect(await screen.findByRole('button', { name: /Support GoPro/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();

    await openCard(user);
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.queryByLabelText('Move to trash')).not.toBeInTheDocument());
  });
});
