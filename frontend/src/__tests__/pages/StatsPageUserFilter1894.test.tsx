/**
 * The Stats filter-by-user dropdown sources names from the slim listing (#1894).
 *
 * `stats:filter_by_user` is a permission an operator can be granted on its own,
 * but the dropdown used to be populated from the admin-level `users:read`
 * listing. An operator who had been granted the filter therefore saw an empty
 * control -- the filter renders only when the user list is non-empty -- and had
 * no way to tell whether that meant "no users" or "not allowed to look".
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { configure, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { StatsPage } from '../../pages/StatsPage';
import { setAuthToken } from '../../api/client';

function signInAs(permissions: string[]) {
  setAuthToken('test-token', 'session');
  server.use(
    http.get('*/api/v1/auth/status', () =>
      HttpResponse.json({ auth_enabled: true, requires_setup: false }),
    ),
    http.get('*/api/v1/auth/me', () =>
      HttpResponse.json({ id: 1, username: 'operator', is_admin: false, permissions }),
    ),
  );
}

// StatsPage's `isLoading` gate (and thus both assertions below, which only
// appear once it clears) is keyed off the /archives/stats query alone, but
// the page also fires /archives/slim and /archives/analysis/failures on
// mount (FailureAnalysisWidget renders unconditionally). None of the three
// have handlers in the shared mocks/handlers.ts or in this file's own
// server.use() calls, and the suite's onUnhandledRequest is 'bypass' (see
// setup.ts) -- so every run of this file previously sent three real fetch()
// calls to http://localhost:3000 (the jsdom test origin), landing on
// whatever, if anything, happens to be listening there (e.g. a stray local
// dev server) instead of MSW. That's a real network round trip standing in
// for what should be a deterministic mock, and a far more likely source of
// the reported timeout than plain CPU contention. Mock all three here the
// same way StatsPage.test.tsx already does for the full widget suite.
const mockArchiveStats = {
  total_prints: 2,
  successful_prints: 2,
  failed_prints: 0,
  cancelled_prints: 0,
  total_print_time_hours: 5,
  total_filament_grams: 200,
  total_cost: 10,
  prints_by_filament_type: {},
  prints_by_printer: {},
  average_time_accuracy: null,
  time_accuracy_by_printer: null,
  total_energy_kwh: 1,
  total_energy_cost: 0.5,
};

const mockFailureAnalysis = {
  period_days: 30,
  total_prints: 0,
  failed_prints: 0,
  failure_rate: 0,
  failures_by_reason: {},
  failures_by_filament: {},
  failures_by_printer: {},
  failures_by_hour: {},
  recent_failures: [],
  trend: [],
};

beforeEach(() => {
  server.use(
    http.get('*/api/v1/archives/stats', () => HttpResponse.json(mockArchiveStats)),
    http.get('*/api/v1/archives/slim', () => HttpResponse.json([])),
    http.get('*/api/v1/archives/analysis/failures', () => HttpResponse.json(mockFailureAnalysis)),
  );
});

afterEach(() => {
  setAuthToken(null);
});

// StatsPage renders many widgets off of one page mount, so even with the
// network calls above now mocked, this is a heavier render than a typical
// waitFor target. RTL's waitFor/findBy* default to a 1s asyncUtilTimeout
// (@testing-library/dom's default, never overridden repo-wide via
// configure()) which this campaign has already seen flake under host load
// elsewhere in the suite (CalculatorPage.test.tsx, PrintModal.test.tsx).
// Raise it file-scoped rather than per-call so it also covers any waitFor
// added here later, and restore the library default afterAll so it can't
// leak into whatever file this worker runs next. 5000ms mirrors
// CalculatorPage.test.tsx's budget: this file has a single waitFor per
// test (no chained round-trips), so it needs less headroom than the
// multi-step flows that justified PrintModal.test.tsx's 8000ms, and 5000ms
// still leaves comfortable room under vitest's 10s per-test timeout.
beforeAll(() => configure({ asyncUtilTimeout: 5000 }));
afterAll(() => configure({ asyncUtilTimeout: 1000 }));

describe('stats filter-by-user (#1894)', () => {
  it('populates from /users/slim without the admin-level users:read', async () => {
    signInAs(['stats:read', 'stats:filter_by_user']);
    server.use(
      // The admin listing is exactly what such an operator cannot call.
      http.get('*/api/v1/users/', () => new HttpResponse(null, { status: 403 })),
      http.get('*/api/v1/users/slim', () =>
        HttpResponse.json([
          { id: 1, username: 'operator' },
          { id: 2, username: 'colleague' },
        ]),
      ),
    );

    render(<StatsPage />);

    // The control only renders once names have arrived, so its presence is
    // the assertion -- an empty list leaves it out of the tree entirely.
    await waitFor(() => {
      expect(screen.getByText('All Users')).toBeInTheDocument();
    });
  });

  it('stays hidden when the user has no filter permission', async () => {
    signInAs(['stats:read']);
    server.use(
      http.get('*/api/v1/users/slim', () =>
        HttpResponse.json([{ id: 1, username: 'operator' }]),
      ),
    );

    render(<StatsPage />);

    await waitFor(() => {
      expect(screen.getByText('Quick Stats')).toBeInTheDocument();
    });
    expect(screen.queryByText('All Users')).not.toBeInTheDocument();
  });
});
