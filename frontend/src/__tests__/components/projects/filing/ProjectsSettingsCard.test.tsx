/**
 * Settings → Projects card: the auto-filing toggle writes
 * projects_auto_file_by_code; the legacy-migration block shows the pending
 * count and a start button, polls progress while running, lists failures and
 * says when nothing is left. Hidden from users without settings:update and
 * projects:update (the migration endpoints require both).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { setAuthToken } from '../../../../api/client';
import type { LegacyMigrationStatus } from '../../../../api/client';
import { ProjectsSettingsCard } from '../../../../components/projects/filing/ProjectsSettingsCard';

beforeAll(() => configure({ asyncUtilTimeout: 5000 }));
afterAll(() => configure({ asyncUtilTimeout: 1000 }));

const idle = (pending: number, failures: LegacyMigrationStatus['failures'] = []): LegacyMigrationStatus => ({
  running: false, total: 0, done: 0, current: null, failures, pending,
});

let statuses: LegacyMigrationStatus[] = [];
let statusCalls = 0;
let startCalls = 0;
let putBody: Record<string, unknown> | null = null;

function serve(autoFile = true) {
  server.use(
    http.get('/api/v1/settings/', () => HttpResponse.json({ currency: 'EUR', projects_auto_file_by_code: autoFile })),
    http.put('/api/v1/settings/', async ({ request }) => {
      putBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ currency: 'EUR', projects_auto_file_by_code: putBody.projects_auto_file_by_code });
    }),
    http.get('/api/v1/projects/legacy-migration/status', () => {
      const s = statuses[Math.min(statusCalls, statuses.length - 1)];
      statusCalls += 1;
      return HttpResponse.json(s);
    }),
    http.post('/api/v1/projects/legacy-migration/start', () => {
      startCalls += 1;
      // The 202 can report total=0 before the worker counts; the card must
      // rely on the polled status instead.
      return HttpResponse.json({ running: true, total: 0, done: 0, current: null, failures: [], pending: 0 }, { status: 202 });
    }),
  );
}

beforeEach(() => {
  statuses = [idle(0)];
  statusCalls = 0;
  startCalls = 0;
  putBody = null;
});

afterEach(() => setAuthToken(null));

describe('ProjectsSettingsCard', () => {
  it('turns auto-filing off', async () => {
    serve(true);
    render(<ProjectsSettingsCard />);
    const toggle = await screen.findByRole('switch', { name: 'File uploads named after a project code' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/P-0042_support\.3mf/)).toBeInTheDocument();
    await userEvent.click(toggle);
    await waitFor(() => expect(putBody).toEqual({ projects_auto_file_by_code: false }));
  });

  it('shows the pending count and starts the migration', async () => {
    statuses = [idle(4), { running: true, total: 4, done: 1, current: { project_id: 9, code: 'P-0009' }, failures: [], pending: 3 }];
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText('4 projects still have files to move')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Move them now' }));
    await waitFor(() => expect(startCalls).toBe(1));
    expect(await screen.findByText('Moving 1/4 — P-0009')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move them now' })).toBeDisabled();
  });

  it('uses the singular for one pending project', async () => {
    statuses = [idle(1)];
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText('1 project still has files to move')).toBeInTheDocument();
  });

  it('polls while running and shows progress until done', async () => {
    statuses = [
      { running: true, total: 12, done: 3, current: { project_id: 7, code: 'P-0007' }, failures: [], pending: 9 },
      idle(0),
    ];
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText('Moving 3/12 — P-0007')).toBeInTheDocument();
    expect(await screen.findByText('Nothing left to move')).toBeInTheDocument();
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button', { name: 'Move them now' })).not.toBeInTheDocument();
  });

  it('lists failures with code and error', async () => {
    statuses = [idle(1, [{ project_id: 3, code: 'P-0003', error: 'checksum mismatch' }])];
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('P-0003')).toBeInTheDocument();
    expect(screen.getByText('checksum mismatch')).toBeInTheDocument();
  });

  it('shows the last run result after a run finishes', async () => {
    statuses = [{
      ...idle(0),
      last_run: { projects: 2, files_moved: 3, files_copied: 1, finished_at: '2026-10-05T10:00:00' },
    }];
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText('Last run: 4 files moved into 2 projects')).toBeInTheDocument();
    expect(screen.getByText('Nothing left to move')).toBeInTheDocument();
  });

  it('uses the singular in the last run result', async () => {
    statuses = [{
      ...idle(1, [{ project_id: 3, code: 'P-0003', error: 'disk on fire' }]),
      last_run: { projects: 1, files_moved: 0, files_copied: 1, finished_at: '2026-10-05T10:00:00' },
    }];
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText('Last run: 1 file moved into 1 project')).toBeInTheDocument();
    expect(screen.getByText('disk on fire')).toBeInTheDocument();
  });

  it('hides the last run result while a run is going', async () => {
    statuses = [{
      running: true, total: 2, done: 0, current: null, failures: [], pending: 2,
      last_run: { projects: 2, files_moved: 3, files_copied: 1, finished_at: '2026-10-05T10:00:00' },
    }];
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText(/Moving 0\/2/)).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-migration-last-run')).not.toBeInTheDocument();
  });

  it('says nothing is left to move', async () => {
    serve();
    render(<ProjectsSettingsCard />);
    expect(await screen.findByText('Nothing left to move')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move them now' })).not.toBeInTheDocument();
  });

  it.each([
    ['settings:update', ['settings:read', 'projects:read', 'projects:update']],
    ['projects:update', ['settings:read', 'settings:update', 'projects:read']],
  ])('is hidden without %s', async (_missing, permissions) => {
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('/api/v1/auth/me', () => HttpResponse.json({
        id: 2, username: 'viewer', role: 'user', is_active: true, is_admin: false,
        groups: [{ id: 2, name: 'Viewers' }], permissions, created_at: '2026-01-01T00:00:00Z',
      })),
    );
    setAuthToken('test-token');
    serve();
    const { container } = render(<ProjectsSettingsCard />);
    // Give auth time to resolve, then the card must still be absent.
    await waitFor(() => expect(statusCalls).toBe(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(container.querySelector('#card-projects-filing')).toBeNull();
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
    expect(statusCalls).toBe(0);
  });
});
