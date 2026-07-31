import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QuoteStatusActions } from '../../components/aito/QuoteStatusActions';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

const project = { id: 12, quote_id: 'EST-9', quote_status: 'draft' } as unknown as AitoProject;

describe('QuoteStatusActions', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('does not fire before the hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={{ ...project, quote_status: 'sent' }} />);

    const accept = screen.getByRole('button', { name: /accept quote/i });
    await user.pointer({ keys: '[MouseLeft>]', target: accept });
    vi.advanceTimersByTime(300);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires once the 500ms hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={{ ...project, quote_status: 'sent' }} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /accept quote/i }) });
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'accepted' }));
  });

  it('renders nothing at all once the quote is accepted', () => {
    render(<QuoteStatusActions project={{ ...project, quote_status: 'accepted' }} />);
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
  });

  it('keeps Accept, and only Accept, on a declined quote', () => {
    // The one way out of 'declined'. It is reachable without anyone choosing
    // it — trashing a project declines its estimate, and re-importing that
    // quote makes a card that is born declined — and nothing else can undo it:
    // the reconciler owns a local decline, so it pushes it back over a
    // Books-side reopen or records a permanent conflict. Deleting this
    // expectation makes 'declined' absorbing again.
    render(<QuoteStatusActions project={{ ...project, quote_status: 'declined' }} />);
    expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
  });

  it('sends the accepted transition from a declined quote', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={{ ...project, quote_status: 'declined' }} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /accept quote/i }) });
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'accepted' }));
  });

  it('drops Mark as sent once the client already has the quote', () => {
    for (const quote_status of ['sent', 'viewed', 'expired']) {
      const { unmount } = render(<QuoteStatusActions project={{ ...project, quote_status }} />);
      expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /decline quote/i })).toBeEnabled();
      unmount();
    }
  });

  it('offers only Mark as sent on a quote the client has not seen', () => {
    // Superseded by the two "offers only Mark as sent" tests below, which
    // cover null and draft individually with the current expectation
    // (Accept/Decline hidden). Kept as a loop over both values for parity
    // with the suite's other status-sweep tests.
    for (const quote_status of [null, 'draft']) {
      const { unmount } = render(<QuoteStatusActions project={{ ...project, quote_status }} />);
      expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('sends the sent transition when its hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={project} />);

    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /mark as sent/i }) });
    vi.advanceTimersByTime(600);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { status: 'sent' }));
  });

  it('offers only Mark as sent while the quote is still a draft', () => {
    // The Quote column IS quote_status null-or-draft: aito_board_rules.evaluate
    // derives the column from the status, so these are the same condition. A
    // quote the client has never received cannot be accepted or declined.
    render(<QuoteStatusActions project={{ ...project, quote_status: 'draft' }} />);
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
  });

  it('offers only Mark as sent on a hand-made card with no quote at all', () => {
    render(<QuoteStatusActions project={{ ...project, quote_id: null, quote_status: null }} />);
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
  });

  it('offers Accept and Decline, and not Mark as sent, once the quote is out', () => {
    for (const status of ['sent', 'viewed', 'expired'] as const) {
      const { unmount } = render(<QuoteStatusActions project={{ ...project, quote_status: status }} />);
      expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /decline quote/i })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
      unmount();
    }
  });
});
