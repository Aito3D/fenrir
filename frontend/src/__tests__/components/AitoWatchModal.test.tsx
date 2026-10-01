import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within, render as rtlRender } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AuthProvider } from '../../contexts/AuthContext';
import { ToastProvider } from '../../contexts/ToastContext';
import type { InboxPreferences } from '../../api/client';
import { server } from '../mocks/server';
import { render, createTestQueryClient } from '../utils';
import { WatchModal } from '../../components/aito/WatchModal';
import { makeProject } from '../fixtures/aitoProject';

const project = makeProject({ id: 41 });

const info = (kind: string, family = 'aito', available = true) => ({ kind, family, default_on: true, available });

const PREFS: InboxPreferences = {
  // Declined and overdue are switched off in this user's Settings.
  kinds: ['aito.quote_viewed', 'aito.quote_accepted', 'aito.paid'],
  sound_kinds: [],
  auto_watch: true,
  available: [
    info('aito.quote_viewed'),
    info('aito.quote_accepted'),
    info('aito.quote_declined'),
    info('aito.paid'),
    info('aito.overdue'),
    info('printer.finished', 'printer', false),
  ],
};

function mockWatch(watch: { watching: boolean; kinds: string[]; follows_settings?: boolean }, put?: () => Response) {
  const puts: { url: string; body: unknown }[] = [];
  server.use(
    http.get('/api/v1/inbox/preferences', () => HttpResponse.json(PREFS)),
    http.get('/api/v1/aito/:id/watch', () => HttpResponse.json(watch)),
    http.put('/api/v1/aito/:id/watch', async ({ request }) => {
      const body = (await request.json()) as { kinds: string[] };
      puts.push({ url: new URL(request.url).pathname, body });
      if (put) return put();
      return HttpResponse.json({ watching: body.kinds.length > 0, kinds: body.kinds });
    }),
  );
  return puts;
}

const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(`^${name}`) });

describe('WatchModal', () => {
  it('lists every Aito kind as a checkbox, greying the ones off in Settings', async () => {
    mockWatch({ watching: false, kinds: [] });
    render(<WatchModal project={project} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Watch this card' });
    expect(within(dialog).getByText('Choose which events about this card reach your inbox.')).toBeInTheDocument();
    await screen.findByRole('checkbox', { name: /^Quote opened by the client/ });

    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    expect(screen.queryByRole('checkbox', { name: /Print finished/ })).not.toBeInTheDocument();
    for (const name of ['Quote opened by the client', 'Quote accepted', 'Payment received']) {
      expect(box(name), name).toBeEnabled();
    }
    for (const name of ['Quote declined', 'Promised date passed']) {
      expect(box(name), name).toBeDisabled();
      expect(box(name), name).not.toBeChecked();
      expect(box(name).closest('label'), name).toHaveTextContent('off in Settings');
    }
    expect(screen.getAllByText('off in Settings')).toHaveLength(2);
  });

  it('says the watch could not be loaded instead of spinning forever', async () => {
    mockWatch({ watching: false, kinds: [] });
    server.use(http.get('/api/v1/aito/:id/watch', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<WatchModal project={project} onClose={vi.fn()} />);
    expect(await screen.findByText("Couldn't load this card's watch")).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('pre-ticks the enabled Aito kinds on an unwatched card and offers no Stop', async () => {
    mockWatch({ watching: false, kinds: [] });
    render(<WatchModal project={project} onClose={vi.fn()} />);
    await screen.findByRole('checkbox', { name: /^Quote opened by the client/ });
    expect(box('Quote opened by the client')).toBeChecked();
    expect(box('Quote accepted')).toBeChecked();
    expect(box('Payment received')).toBeChecked();
    expect(screen.queryByRole('button', { name: 'Stop watching' })).not.toBeInTheDocument();
  });

  it('ticks only the watched kinds on a watched card', async () => {
    mockWatch({ watching: true, kinds: ['aito.paid'] });
    render(<WatchModal project={project} onClose={vi.fn()} />);
    await waitFor(() => expect(box('Payment received')).toBeChecked());
    expect(box('Quote opened by the client')).not.toBeChecked();
    expect(box('Quote accepted')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Stop watching' })).toBeInTheDocument();
  });

  it('disables Save once nothing is ticked on an unwatched card', async () => {
    mockWatch({ watching: false, kinds: [] });
    const user = userEvent.setup();
    render(<WatchModal project={project} onClose={vi.fn()} />);
    await screen.findByRole('checkbox', { name: /^Quote opened by the client/ });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    for (const name of ['Quote opened by the client', 'Quote accepted', 'Payment received']) {
      await user.click(box(name));
    }
    expect(save).toBeDisabled();
  });

  it('Save PUTs the ticked kinds, writes the watch cache, toasts and closes', async () => {
    const puts = mockWatch({ watching: false, kinds: [] });
    const queryClient = createTestQueryClient();
    queryClient.setQueryDefaults(['aito-watch', 41], { gcTime: Infinity });
    const onClose = vi.fn();
    const user = userEvent.setup();
    rtlRender(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ToastProvider>
              <WatchModal project={project} onClose={onClose} />
            </ToastProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('checkbox', { name: /^Quote accepted/ });
    await user.click(box('Quote accepted'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([{ url: '/api/v1/aito/41/watch', body: { kinds: ['aito.quote_viewed', 'aito.paid'] } }]);
    expect(queryClient.getQueryData(['aito-watch', 41])).toEqual({
      watching: true,
      kinds: ['aito.quote_viewed', 'aito.paid'],
    });
    expect(await screen.findByText('You now watch this card')).toBeInTheDocument();
  });

  it('Stop watching PUTs an empty list, toasts and closes', async () => {
    const puts = mockWatch({ watching: true, kinds: ['aito.paid'] });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<WatchModal project={project} onClose={onClose} />);
    await user.click(await screen.findByRole('button', { name: 'Stop watching' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([{ url: '/api/v1/aito/41/watch', body: { kinds: [] } }]);
    expect(await screen.findByText('You no longer watch this card')).toBeInTheDocument();
  });

  it('keeps the dialog open and shows the detail when the server refuses a kind', async () => {
    mockWatch({ watching: false, kinds: [] }, () =>
      HttpResponse.json({ detail: "kind disabled in preferences: ['aito.paid']" }, { status: 422 }),
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<WatchModal project={project} onClose={onClose} />);
    await screen.findByRole('checkbox', { name: /^Quote accepted/ });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("kind disabled in preferences: ['aito.paid']");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Watch this card' })).toBeInTheDocument();
  });

  it('says an auto-watch follows Settings, and an unedited Save keeps it that way', async () => {
    const puts = mockWatch({ watching: true, kinds: ['aito.quote_viewed', 'aito.paid'], follows_settings: true });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<WatchModal project={project} onClose={onClose} />);
    expect(await screen.findByText('Follows your Settings')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([]);
  });

  it('saving an edited selection on an auto-watch makes it explicit', async () => {
    const puts = mockWatch({ watching: true, kinds: ['aito.quote_viewed', 'aito.paid'], follows_settings: true });
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<WatchModal project={project} onClose={onClose} />);
    await screen.findByText('Follows your Settings');
    await user.click(box('Quote opened by the client'));
    expect(screen.queryByText('Follows your Settings')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([{ url: '/api/v1/aito/41/watch', body: { kinds: ['aito.paid'] } }]);
  });

  it('shows no Settings line on an explicit watch', async () => {
    mockWatch({ watching: true, kinds: ['aito.paid'], follows_settings: false });
    render(<WatchModal project={project} onClose={vi.fn()} />);
    await waitFor(() => expect(box('Payment received')).toBeChecked());
    expect(screen.queryByText('Follows your Settings')).not.toBeInTheDocument();
  });
});
