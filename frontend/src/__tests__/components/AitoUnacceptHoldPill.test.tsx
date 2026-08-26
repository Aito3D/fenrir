import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { UnacceptHoldPill, UNACCEPT_HOLD_MS, UNACCEPT_SETTLE_MS } from '../../components/aito/UnacceptHoldPill';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { flashRevert } from '../../hooks/useRevertFlash';

// Same module-level mock AitoQuoteStatusActions.test.tsx uses, and for the
// same reason: `flashRevert` is imported as a direct binding by
// useOptimisticBoardMutation, so spying on the namespace patches an object
// nobody reads.
vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));

const project = { id: 12, quote_id: 'EST-9', quote_status: 'accepted' } as unknown as AitoProject;

describe('UnacceptHoldPill', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    __resetBoardSync();
    vi.mocked(flashRevert).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('renders the accepted label as a hold button', () => {
    render(<UnacceptHoldPill project={project} onDone={vi.fn()} />);
    const pill = screen.getByRole('button', { name: /remove acceptance/i });
    expect(pill).toHaveTextContent('Accepted');
  });

  it('does not fire before the full hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true, no_op: false });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<UnacceptHoldPill project={project} onDone={vi.fn()} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /remove acceptance/i }) });
    vi.advanceTimersByTime(UNACCEPT_HOLD_MS - 200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('marks the pill as holding while pressed, for the inflate/redden styling', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<UnacceptHoldPill project={project} onDone={vi.fn()} />);

    const pill = screen.getByRole('button', { name: /remove acceptance/i });
    expect(pill).not.toHaveAttribute('data-holding');
    await user.pointer({ keys: '[MouseLeft>]', target: pill });
    expect(pill).toHaveAttribute('data-holding');
  });

  it('sweeps a progress fill across the pill while holding', async () => {
    // The fill is the progress indicator: red sweeping left to right over the
    // still-green pill, exactly one hold-duration long. Present in the DOM at
    // rest (collapsed) so the sweep is a transition, not a mount.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<UnacceptHoldPill project={project} onDone={vi.fn()} />);

    const fill = screen.getByTestId('unaccept-progress-fill');
    expect(fill.className).toContain('scale-x-0');
    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /remove acceptance/i }) });
    expect(fill.className).toContain('scale-x-100');
  });

  it('an early release cancels and surfaces the hold hint', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true, no_op: false });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<UnacceptHoldPill project={project} onDone={vi.fn()} />);

    const pill = screen.getByRole('button', { name: /remove acceptance/i });
    await user.pointer({ keys: '[MouseLeft>]', target: pill });
    vi.advanceTimersByTime(200);
    await user.pointer({ keys: '[/MouseLeft]', target: pill });

    expect(pill).not.toHaveAttribute('data-holding');
    expect(screen.getByText(/hold 1s to remove acceptance/i)).toBeInTheDocument();
    vi.advanceTimersByTime(UNACCEPT_HOLD_MS + UNACCEPT_SETTLE_MS + 500);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires the revoke only after the settle bounce, then reports done', async () => {
    // The choreography the feature was specced as: the hold completes, the
    // pill deflates back to rest (staying red), and ONLY once it has settled
    // does the card move and the panel close. Firing at completion instead
    // would optimistically flip quote_status and unmount the pill mid-bounce.
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true, no_op: false });
    const onDone = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<UnacceptHoldPill project={project} onDone={onDone} />);

    const pill = screen.getByRole('button', { name: /remove acceptance/i });
    await user.pointer({ keys: '[MouseLeft>]', target: pill });
    await act(async () => {
      vi.advanceTimersByTime(UNACCEPT_HOLD_MS + 50);
    });

    // Hold complete: settling, nothing sent yet.
    expect(pill).toHaveAttribute('data-settling');
    expect(spy).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(UNACCEPT_SETTLE_MS + 50);
    });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'sent' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a pointer leaving the pill cancels the hold', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true, no_op: false });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<UnacceptHoldPill project={project} onDone={vi.fn()} />);

    const pill = screen.getByRole('button', { name: /remove acceptance/i });
    await user.pointer({ keys: '[MouseLeft>]', target: pill });
    await user.pointer({ target: document.body });

    expect(pill).not.toHaveAttribute('data-holding');
    vi.advanceTimersByTime(UNACCEPT_HOLD_MS + UNACCEPT_SETTLE_MS + 500);
    expect(spy).not.toHaveBeenCalled();
  });
});
