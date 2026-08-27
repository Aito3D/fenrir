/**
 * Filament Profiles page — permission gating (T-016).
 *
 * Every mutating control (Sync base, Import, Sync Zoho prices, Sync to PC,
 * New preset, and the per-preset row/menu actions and editor Save button)
 * is gated on the permission its own backend endpoint enforces
 * (RequirePermissionIfAuthEnabled in routes/filament_profiles.py). A
 * separate file from FilamentProfilesPage.test.tsx, mirroring
 * PrintersPageDropPermission.test.tsx, because mocking useAuth here applies
 * to the whole file and would otherwise change every existing test's
 * (auth-disabled) baseline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const permissions = { granted: ['filaments:read'] as string[] };

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
  hasPermission: vi.fn((permission: string) => !mockUseAuth.authEnabled || permissions.granted.includes(permission)),
  hasAnyPermission: vi.fn(() => true),
  hasAllPermissions: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

import { render } from '../utils';
import { FilamentProfilesPage } from '../../pages/FilamentProfilesPage';
import type { FilamentPreset } from '../../api/client';

function preset(overrides: Partial<FilamentPreset> = {}): FilamentPreset {
  return {
    id: 1,
    name: 'Bambu PLA Basic - Black',
    brand: 'Bambu',
    material: 'PLA',
    color: 'Black',
    color_hex: '#000000',
    filename: 'bambu_pla_basic_black.json',
    content: '{}',
    ...overrides,
  };
}

const PRESETS: FilamentPreset[] = [preset()];

function stubBase() {
  server.use(
    http.get('*/filament-profiles', () => HttpResponse.json(PRESETS)),
    http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
    http.get('*/filament-catalog/', () => HttpResponse.json([])),
  );
}

beforeEach(() => {
  permissions.granted = ['filaments:read'];
});

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
});

describe('FilamentProfilesPage — permission gating (T-016)', () => {
  it('hides every mutating header button when the user only has filaments:read', async () => {
    stubBase();
    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    expect(screen.queryByRole('button', { name: /sync base/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^import$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync prices from zoho/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync to pc/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new preset/i })).not.toBeInTheDocument();

    // Export ZIP hits no endpoint (client-side zip of already-loaded data),
    // so it stays visible regardless of permission.
    expect(screen.getByRole('button', { name: /export zip/i })).toBeInTheDocument();
  });

  it('hides the per-preset row menu entirely when none of create/update/delete are granted', async () => {
    stubBase();
    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    expect(screen.queryByRole('button', { name: /menu/i })).not.toBeInTheDocument();
  });

  it('hides the editor Save button for a read-only user who opens an existing preset', async () => {
    stubBase();
    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    await userEvent.click(screen.getByText('Black'));
    await screen.findByRole('dialog');

    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    // Cancel must stay reachable so the read-only user can still back out.
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows only the row actions matching the permissions actually granted', async () => {
    permissions.granted = ['filaments:read', 'filaments:update'];
    stubBase();
    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    await userEvent.click(screen.getByRole('button', { name: /menu/i }));
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^duplicate$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('shows every mutating control when the user holds every filaments permission', async () => {
    permissions.granted = ['filaments:read', 'filaments:create', 'filaments:update', 'filaments:delete'];
    stubBase();
    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    expect(screen.getByRole('button', { name: /sync base/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^import$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync prices from zoho/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync to pc/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new preset/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /menu/i }));
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^duplicate$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
  });

  it('shows every mutating control on auth-disabled installs regardless of the (unused) permission set', async () => {
    mockUseAuth.authEnabled = false;
    try {
      stubBase();
      render(<FilamentProfilesPage />);
      await screen.findByText('Black');

      expect(screen.getByRole('button', { name: /sync base/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^import$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sync prices from zoho/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sync to pc/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /new preset/i })).toBeInTheDocument();
    } finally {
      mockUseAuth.authEnabled = true;
    }
  });
});
