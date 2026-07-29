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

  it('disables the action matching the current status', () => {
    render(<QuoteStatusActions project={{ ...project, quote_status: 'accepted' }} />);
    expect(screen.getByRole('button', { name: /accept quote/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /decline quote/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
  });

  it('keeps Mark as sent live on a viewed quote — re-sending is a real thing to do', () => {
    render(<QuoteStatusActions project={{ ...project, quote_status: 'viewed' }} />);
    expect(screen.getByRole('button', { name: /mark as sent/i })).toBeEnabled();
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
