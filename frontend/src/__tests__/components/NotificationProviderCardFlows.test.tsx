/**
 * Flow tests for NotificationProviderCard against msw: test, delete, enable
 * toggle, quick event toggles, quiet hours / digest / photo toggles, edit,
 * expand/collapse and the pause-upcoming flag.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { NotificationProviderCard } from '../../components/NotificationProviderCard';
import type { NotificationProvider } from '../../api/client';

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

function buildProvider(overrides: Partial<NotificationProvider> = {}): NotificationProvider {
  return {
    id: 7,
    name: 'Flow Provider',
    provider_type: 'ntfy',
    enabled: true,
    config: { server: 'https://ntfy.sh', topic: 'fenrir' },
    on_print_start: false,
    on_print_complete: false,
    on_print_failed: false,
    on_print_stopped: false,
    on_print_progress: false,
    on_printer_offline: false,
    on_printer_error: false,
    on_ai_failure_detection: false,
    on_filament_low: false,
    on_maintenance_due: false,
    on_plate_not_empty: false,
    quiet_hours_enabled: false,
    quiet_hours_start: null,
    quiet_hours_end: null,
    daily_digest_enabled: false,
    daily_digest_time: null,
    printer_id: null,
    last_success: null,
    last_error: null,
    last_error_at: null,
    created_at: '2026-04-25T00:00:00Z',
    updated_at: '2026-04-25T00:00:00Z',
    ...overrides,
  } as NotificationProvider;
}

function capturePatch() {
  const captured: unknown[] = [];
  server.use(
    http.patch('*/api/v1/notifications/7', async ({ request }) => {
      captured.push(await request.json());
      return HttpResponse.json(buildProvider());
    }),
  );
  return captured;
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByText('Event Settings'));
}

/** The switch in the same row as the given label text. */
function switchFor(label: string) {
  const row = screen.getByText(label).closest('div.flex.items-center.justify-between') as HTMLElement;
  return within(row).getByRole('switch');
}

describe('NotificationProviderCard — test button', () => {
  it('renders the success message from the test endpoint', async () => {
    server.use(
      http.post('*/api/v1/notifications/7/test', () =>
        HttpResponse.json({ success: true, message: 'Delivered OK' }),
      ),
    );
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);

    await user.click(await screen.findByText('Send Test Notification'));

    expect(await screen.findByText('Delivered OK')).toBeInTheDocument();
  });

  it('renders the failure message returned by the test endpoint', async () => {
    server.use(
      http.post('*/api/v1/notifications/7/test', () =>
        HttpResponse.json({ success: false, message: 'Server said no' }),
      ),
    );
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);

    await user.click(await screen.findByText('Send Test Notification'));

    expect(await screen.findByText('Server said no')).toBeInTheDocument();
  });

  it('renders the error message when the test request fails', async () => {
    server.use(
      http.post('*/api/v1/notifications/7/test', () =>
        HttpResponse.json({ detail: 'Backend exploded' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);

    await user.click(await screen.findByText('Send Test Notification'));

    expect(await screen.findByText('Backend exploded')).toBeInTheDocument();
  });

  it('is hidden when the provider is disabled', async () => {
    render(<NotificationProviderCard provider={buildProvider({ enabled: false })} onEdit={vi.fn()} />);
    await screen.findByText('Flow Provider');
    expect(screen.queryByText('Send Test Notification')).not.toBeInTheDocument();
  });
});

describe('NotificationProviderCard — delete', () => {
  it('asks for confirmation and deletes the provider by id', async () => {
    const deleted: string[] = [];
    server.use(
      http.delete('*/api/v1/notifications/:id', ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({ message: 'ok' });
      }),
    );
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);
    await expand(user);

    // Trash button is the icon-only button after Edit
    const editBtn = screen.getByRole('button', { name: /edit/i });
    await user.click(editBtn.nextElementSibling as HTMLElement);

    expect(await screen.findByText('Delete Notification Provider')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete "Flow Provider"/)).toBeInTheDocument();
    expect(deleted).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleted).toEqual(['7']));
    await waitFor(() => expect(screen.queryByText('Delete Notification Provider')).not.toBeInTheDocument());
  });

  it('cancel closes the confirmation without deleting', async () => {
    const deleted: string[] = [];
    server.use(
      http.delete('*/api/v1/notifications/:id', ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({ message: 'ok' });
      }),
    );
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);
    await expand(user);

    await user.click(screen.getByRole('button', { name: /edit/i }).nextElementSibling as HTMLElement);
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText('Delete Notification Provider')).not.toBeInTheDocument());
    expect(deleted).toEqual([]);
  });
});

describe('NotificationProviderCard — toggles and edit', () => {
  it('header toggle disables an enabled provider', async () => {
    const captured = capturePatch();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);

    await user.click((await screen.findAllByRole('switch'))[0]);

    await waitFor(() => expect(captured).toEqual([{ enabled: false }]));
  });

  it('header toggle enables a disabled provider', async () => {
    const captured = capturePatch();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider({ enabled: false })} onEdit={vi.fn()} />);

    await user.click((await screen.findAllByRole('switch'))[0]);

    await waitFor(() => expect(captured).toEqual([{ enabled: true }]));
  });

  it('expanded Enabled toggle sends the enabled payload', async () => {
    const captured = capturePatch();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);
    await expand(user);

    await user.click(switchFor('Enabled'));

    await waitFor(() => expect(captured).toEqual([{ enabled: false }]));
  });

  it.each([
    ['Print Started', 'on_print_start', false, true],
    ['Print Failed', 'on_print_failed', false, true],
    ['Plate Not Empty', 'on_plate_not_empty', false, true],
  ])('quick toggle %s sends %s', async (label, key, _from, to) => {
    const captured = capturePatch();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);
    await expand(user);

    await user.click(switchFor(label));

    await waitFor(() => expect(captured).toEqual([{ [key]: to }]));
  });

  it('quick toggle turns an enabled event off', async () => {
    const captured = capturePatch();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider({ on_print_start: true })} onEdit={vi.fn()} />);
    await expand(user);

    const sw = switchFor('Print Started');
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);

    await waitFor(() => expect(captured).toEqual([{ on_print_start: false }]));
  });

  it('pause-upcoming toggle sends on_print_pause_upcoming', async () => {
    const captured = capturePatch();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);
    await expand(user);

    const label = screen.getAllByText(/pause/i).find((el) => el.tagName === 'P' && el.className.includes('text-white'))!;
    const row = label.closest('div.flex.items-center.justify-between') as HTMLElement;
    await user.click(within(row).getByRole('switch'));

    await waitFor(() => expect(captured).toEqual([{ on_print_pause_upcoming: true }]));
  });

  it('quiet hours, daily digest and attach photo toggles send their payloads', async () => {
    const captured = capturePatch();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);
    await expand(user);

    await user.click(switchFor('Quiet Hours'));
    await user.click(switchFor('Daily Digest'));
    await user.click(switchFor('Attach Photo'));

    await waitFor(() => expect(captured).toHaveLength(3));
    expect(captured).toEqual([
      { quiet_hours_enabled: true },
      { daily_digest_enabled: true },
      { attach_photo: false },
    ]);
  });

  it('shows quiet hours and digest details with defaults when enabled', async () => {
    const user = userEvent.setup();
    render(
      <NotificationProviderCard
        provider={buildProvider({ quiet_hours_enabled: true, daily_digest_enabled: true })}
        onEdit={vi.fn()}
      />,
    );
    await expand(user);

    expect(screen.getByText('22:00 - 07:00')).toBeInTheDocument();
    expect(screen.getByText(/08:00/)).toBeInTheDocument();
  });

  it('shows configured quiet hours', async () => {
    const user = userEvent.setup();
    render(
      <NotificationProviderCard
        provider={buildProvider({ quiet_hours_enabled: true, quiet_hours_start: '23:30', quiet_hours_end: '06:15' })}
        onEdit={vi.fn()}
      />,
    );
    await expand(user);

    expect(screen.getByText('23:30 - 06:15')).toBeInTheDocument();
  });

  it('Edit calls onEdit with the provider', async () => {
    const onEdit = vi.fn();
    const provider = buildProvider();
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={provider} onEdit={onEdit} />);
    await expand(user);

    await user.click(screen.getByRole('button', { name: /edit/i }));

    expect(onEdit).toHaveBeenCalledWith(provider);
  });

  it('expand and collapse the settings panel', async () => {
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);

    expect(screen.queryByText('Quiet Hours')).not.toBeInTheDocument();
    await expand(user);
    expect(screen.getByText('Quiet Hours')).toBeInTheDocument();
    await user.click(screen.getByText('Event Settings'));
    expect(screen.queryByText('Quiet Hours')).not.toBeInTheDocument();
  });

  it('a failing update does not crash the card', async () => {
    server.use(
      http.patch('*/api/v1/notifications/7', () => HttpResponse.json({ detail: 'nope' }, { status: 500 })),
    );
    const user = userEvent.setup();
    render(<NotificationProviderCard provider={buildProvider()} onEdit={vi.fn()} />);
    await expand(user);

    await user.click(switchFor('Print Started'));

    expect(await screen.findByText('Flow Provider')).toBeInTheDocument();
  });
});
