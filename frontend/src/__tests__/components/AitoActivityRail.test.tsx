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
});
