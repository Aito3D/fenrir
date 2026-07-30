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
    render(<QuoteStatusActions project={project} />);

    const accept = screen.getByRole('button', { name: /accept quote/i });
    await user.pointer({ keys: '[MouseLeft>]', target: accept });
    vi.advanceTimersByTime(300);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fires once the 500ms hold completes', async () => {
    const spy = vi.spyOn(api, 'setAitoQuoteStatus').mockResolvedValue({ project, zoho_synced: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<QuoteStatusActions project={project} />);

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

  it('renders nothing at all once the quote is declined', () => {
    render(<QuoteStatusActions project={{ ...project, quote_status: 'declined' }} />);
    expect(screen.queryByRole('button', { name: /accept quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline quote/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as sent/i })).not.toBeInTheDocument();
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

  it('offers all three on a quote the client has not seen', () => {
    for (const quote_status of [null, 'draft']) {
      const { unmount } = render(<QuoteStatusActions project={{ ...project, quote_status }} />);
      expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /accept quote/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /decline quote/i })).toBeEnabled();
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
});
