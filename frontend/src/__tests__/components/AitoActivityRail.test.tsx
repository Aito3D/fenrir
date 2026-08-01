import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ActivityRail } from '../../components/aito/history/ActivityRail';
import { api } from '../../api/client';
import type { AitoEvent } from '../../api/client';

const event = (over: Partial<AitoEvent>): AitoEvent => ({
  id: 1,
  occurred_at: '2026-07-29T12:00:00',
  occurred_until: null,
  kind: 'task.updated',
  actor_class: 'user',
  actor_name: 'paul',
  subject_type: 'task',
  subject_id: 3,
  subject_label: 'Socle',
  changes: null,
  detail: null,
  note: null,
  ...over,
});

describe('ActivityRail', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the actor and what they did', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [event({ actor_name: 'paul', kind: 'task.added', subject_label: 'Socle' })],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/paul/)).toBeInTheDocument();
    expect(screen.getByText(/added a task/i)).toBeInTheDocument();
  });

  it('sits the depth control on the title\'s row, not underneath it', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    render(<ActivityRail projectId={12} />);

    // The heading and the control that decides what the heading lists share
    // one flex row. Stacking them spent a whole line of a 22rem column on a
    // 166px control, and put the two two rows apart.
    const title = await screen.findByText(/^activity$/i);
    const depthButton = screen.getByRole('button', { name: /story/i });
    const row = title.parentElement!;

    expect(row.className).toContain('flex');
    expect(row.className).toContain('justify-between');
    expect(row.contains(depthButton)).toBe(true);
  });

  it('defaults to detail depth and refetches when the depth changes', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(12, expect.objectContaining({ depth: 'detail' })),
    );

    await user.click(screen.getByRole('button', { name: /story/i }));
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(12, expect.objectContaining({ depth: 'story' })),
    );
  });

  it('shows an inline diff for a single change', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({ changes: [{ field: 'impression_cost', from: 4200, to: 5600 }] }),
      ],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/4200/)).toBeInTheDocument();
    expect(screen.getByText(/5600/)).toBeInTheDocument();
  });

  it('collapses several changes behind a count', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({
          changes: [
            { field: 'title', from: 'Socle', to: 'Socle v2' },
            { field: 'impression_cost', from: 4200, to: 5600 },
            { field: 'impression_quantity', from: 1, to: 12 },
          ],
        }),
      ],
      has_more: false,
    });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const toggle = await screen.findByRole('button', { name: /3 changes/i });
    expect(screen.queryByText(/impression_quantity|quantity/i)).not.toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => expect(screen.getByText(/12/)).toBeInTheDocument());
  });

  it('submits a note and clears the box', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    const add = vi.spyOn(api, 'addAitoNote').mockResolvedValue(event({ kind: 'note.added', note: 'Called client' }));
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const box = await screen.findByPlaceholderText(/add a note/i);
    await user.type(box, 'Called client');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    await waitFor(() => expect(add).toHaveBeenCalledWith(12, 'Called client'));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('shows the note and clears the box before the POST resolves', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    let release: (value: AitoEvent) => void = () => {};
    vi.spyOn(api, 'addAitoNote').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const box = await screen.findByPlaceholderText(/add a note/i);
    await user.type(box, 'called the client');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    expect(screen.getByText('called the client')).toBeInTheDocument();
    expect(box).toHaveValue('');

    release(event({ id: 99, kind: 'note.added', note: 'called the client' }));
  });

  it('removes the note and restores the text when the POST fails', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    vi.spyOn(api, 'addAitoNote').mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    const box = await screen.findByPlaceholderText(/add a note/i);
    await user.type(box, 'called the client');
    await user.click(screen.getByRole('button', { name: /add note/i }));

    await waitFor(() => expect(screen.queryByText('called the client')).not.toBeInTheDocument());
    // The text comes back so the user does not have to retype it.
    expect(box).toHaveValue('called the client');
  });

  it('renders the verbatim Books text for an unrecognised zoho.comment', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({
          kind: 'zoho.comment',
          actor_class: 'system',
          actor_name: null,
          subject_type: null,
          subject_id: null,
          subject_label: null,
          detail: { text: 'La mise à jour du champ set expiration est exécutée' },
        }),
      ],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/set expiration est exécutée/)).toBeInTheDocument();
  });

  it('renders the reason for a sync.failed event', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({
      events: [
        event({
          kind: 'sync.failed',
          actor_class: 'system',
          actor_name: null,
          subject_type: null,
          subject_id: null,
          subject_label: null,
          detail: { error: 'Zoho rejected the request: duplicate reference number', failures: 3 },
        }),
      ],
      has_more: false,
    });
    render(<ActivityRail projectId={12} />);

    expect(await screen.findByText(/duplicate reference number/)).toBeInTheDocument();
  });

  it('says so when there is nothing to show', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [], has_more: false });
    render(<ActivityRail projectId={12} />);
    expect(await screen.findByText(/nothing recorded yet/i)).toBeInTheDocument();
  });

  it('offers load-more only when the server says there is more', async () => {
    vi.spyOn(api, 'getAitoEvents').mockResolvedValue({ events: [event({})], has_more: false });
    render(<ActivityRail projectId={12} />);
    await screen.findByText(/paul/);
    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });

  it('pages with the (id, occurredAt) cursor pair taken from the last event of the page', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents');
    spy.mockResolvedValueOnce({
      events: [
        event({ id: 99, occurred_at: '2026-07-29T12:00:00', actor_name: 'first-event' }),
        event({ id: 5, occurred_at: '2020-01-01T00:00:00', actor_name: 'oldest-event' }),
      ],
      has_more: true,
    });
    spy.mockResolvedValueOnce({
      events: [event({ id: 4, occurred_at: '2019-12-31T00:00:00', actor_name: 'second-page-event' })],
      has_more: false,
    });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    await screen.findByText(/oldest-event/);

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // The cursor must be the pair from the LAST event of the first page (id 5),
    // not the first event's (id 99), and not a bare id.
    expect(spy).toHaveBeenNthCalledWith(
      2,
      12,
      expect.objectContaining({
        cursor: { id: 5, occurredAt: '2020-01-01T00:00:00' },
      }),
    );
  });

  it('appends the next page instead of replacing the first one', async () => {
    const spy = vi.spyOn(api, 'getAitoEvents');
    spy.mockResolvedValueOnce({
      events: [
        event({ id: 99, occurred_at: '2026-07-29T12:00:00', actor_name: 'first-event' }),
        event({ id: 5, occurred_at: '2020-01-01T00:00:00', actor_name: 'oldest-event' }),
      ],
      has_more: true,
    });
    spy.mockResolvedValueOnce({
      events: [event({ id: 4, occurred_at: '2019-12-31T00:00:00', actor_name: 'second-page-event' })],
      has_more: false,
    });
    const user = userEvent.setup();
    render(<ActivityRail projectId={12} />);

    await screen.findByText(/oldest-event/);

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText(/second-page-event/);
    expect(screen.getByText(/first-event/)).toBeInTheDocument();
    expect(screen.getByText(/oldest-event/)).toBeInTheDocument();
  });
});
