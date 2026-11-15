/**
 * Filament Profiles page — permission gating (T-016), tree edition.
 *
 * Every mutating control (SYNC, tree settings, organise into trees, Zoho
 * prices, node value inputs) is gated on the permission(s) its own backend
 * route enforces (routes/filament_trees.py, filament_profiles.py). A
 * separate file from FilamentProfilesPage.test.tsx because mocking useAuth
 * here applies to the whole file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';

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
import { api } from '../../api/client';
import type { FilamentTreeSummary } from '../../api/client';

const TREE: FilamentTreeSummary = {
  id: 1,
  name: 'Polymaker PETG',
  brand: 'Polymaker',
  material: 'PETG',
  skip_02: null,
  abrasive: false,
  source: { machine: 'X2D', nozzle: '0.4', color_id: 10 },
  colors: [{ id: 10, name: 'White', hex: '#ffffff' }],
  own_counts: {},
};

function stubBase() {
  vi.spyOn(api, 'getFilamentTrees').mockResolvedValue([TREE]);
  vi.spyOn(api, 'getFilamentPresets').mockResolvedValue([]);
  vi.spyOn(api, 'getFilamentTreeTargets').mockResolvedValue({ machines: ['X2D'], nozzles: ['0.4'] });
  vi.spyOn(api, 'getUnmanagedFilamentGroups').mockResolvedValue([
    {
      prefix: 'SUNLU PLA',
      preset_ids: [5],
      proposed_source_preset_id: 5,
      proposed_machine: 'X2D',
      proposed_nozzle: '0.4',
      warnings: [],
    },
  ]);
  vi.spyOn(api, 'getFilamentTreeNode').mockResolvedValue([
    { key: 'nozzle_temperature', value: ['240'], source: 'root', own: true },
  ]);
}

beforeEach(() => {
  permissions.granted = ['filaments:read'];
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderPage() {
  stubBase();
  render(<FilamentProfilesPage />);
  // the root's settings row is on screen once trees and node rows have loaded
  await screen.findByText('nozzle_temperature');
}

describe('FilamentProfilesPage — permission gating (T-016)', () => {
  it('hides every mutating control when the user only has filaments:read', async () => {
    await renderPage();

    expect(screen.queryByRole('button', { name: 'SYNC' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tree settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /not in a tree/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync base/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync to pc/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sync prices from zoho/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use parent/i })).not.toBeInTheDocument();

    // Export only reads, so it stays visible regardless of permission.
    expect(screen.getByRole('button', { name: 'Export for Orca' })).toBeInTheDocument();
  });

  it('needs orca_cloud:auth as well as filaments:update for SYNC', async () => {
    permissions.granted = ['filaments:read', 'filaments:update'];
    await renderPage();
    expect(screen.queryByRole('button', { name: 'SYNC' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tree settings' })).toBeInTheDocument();
    // Sync base and Sync to PC keep their old filaments:update gate.
    expect(screen.getByRole('button', { name: /sync base/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync to pc/i })).toBeInTheDocument();
  });

  it('shows every mutating control when the user holds every filaments permission and Orca auth', async () => {
    permissions.granted = ['filaments:read', 'filaments:create', 'filaments:update', 'filaments:delete', 'orca_cloud:auth'];
    await renderPage();

    expect(screen.getByRole('button', { name: 'SYNC' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tree settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not in a tree (1)' })).toBeInTheDocument();
    // T-027: the zoho-sync backend route also requires calculator:update.
    expect(screen.queryByRole('button', { name: /sync prices from zoho/i })).not.toBeInTheDocument();
  });

  describe('zoho price sync button (T-027 — requires filaments:update AND calculator:update)', () => {
    it('hides the button when only filaments:update is granted', async () => {
      permissions.granted = ['filaments:read', 'filaments:update'];
      await renderPage();
      expect(screen.queryByRole('button', { name: /sync prices from zoho/i })).not.toBeInTheDocument();
    });

    it('shows the button when both filaments:update and calculator:update are granted', async () => {
      permissions.granted = ['filaments:read', 'filaments:update', 'calculator:update'];
      await renderPage();
      expect(screen.getByRole('button', { name: /sync prices from zoho/i })).toBeInTheDocument();
    });

    it('hides the button when only calculator:update is granted', async () => {
      permissions.granted = ['filaments:read', 'calculator:update'];
      await renderPage();
      expect(screen.queryByRole('button', { name: /sync prices from zoho/i })).not.toBeInTheDocument();
    });
  });

  it('shows every mutating control on auth-disabled installs regardless of the (unused) permission set', async () => {
    mockUseAuth.authEnabled = false;
    try {
      await renderPage();
      expect(screen.getByRole('button', { name: 'SYNC' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Tree settings' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /sync prices from zoho/i })).toBeInTheDocument();
    } finally {
      mockUseAuth.authEnabled = true;
    }
  });
});
