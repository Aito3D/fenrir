import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { QuotePrintButton } from '../../components/aito/QuotePrintButton';
import { QuoteDownloadButton } from '../../components/aito/QuoteDownloadButton';
import { canCreateInvoice } from '../../components/aito/canCreateInvoice';
import { documentFailureMessage, isSyncPendingError } from '../../components/aito/syncPending';
import { api, ApiError } from '../../api/client';
import type { AitoProject } from '../../api/client';

const pending = {
  id: 12,
  quote_id: 'EST-9',
  quote_number: 'QT-00412',
  quote_sync_state: 'pending',
} as unknown as AitoProject;

const syncPending = () => new ApiError('Zoho has not confirmed the latest changes yet', 503, 'sync_pending');

afterEach(() => vi.restoreAllMocks());

describe('sync_pending errors', () => {
  it('recognises the structured 503 and nothing else', () => {
    expect(isSyncPendingError(syncPending())).toBe(true);
    expect(isSyncPendingError(new ApiError('Bad gateway', 502))).toBe(false);
    expect(isSyncPendingError(new Error('sync_pending'))).toBe(false);
  });

  it('picks the translated sentence for it and the fallback otherwise', () => {
    const t = ((key: string) => `T:${key}`) as never;
    expect(documentFailureMessage(syncPending(), 'fallback', t)).toBe('T:aito.syncNotConfirmed');
    expect(documentFailureMessage(new Error('boom'), 'fallback', t)).toBe('fallback');
  });
});

describe('document buttons while a push is pending', () => {
  it('print stays enabled and asks the server, which pushes first', async () => {
    const fetchPdf = vi.spyOn(api, 'getAitoQuotePdf').mockResolvedValue(new Blob(['%PDF']));
    render(<QuotePrintButton project={pending} />);
    const button = screen.getByRole('button', { name: /print quote/i });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(fetchPdf).toHaveBeenCalledWith(12));
  });

  it('download stays enabled too', () => {
    render(<QuoteDownloadButton project={pending} />);
    expect(screen.getByRole('button', { name: /download quote/i })).toBeEnabled();
  });

  it('print says Zoho has not confirmed when the push does not land', async () => {
    vi.spyOn(api, 'getAitoQuotePdf').mockRejectedValue(syncPending());
    render(<QuotePrintButton project={pending} />);
    await userEvent.click(screen.getByRole('button', { name: /print quote/i }));
    await waitFor(() =>
      expect(screen.getByText(/zoho has not confirmed the latest changes yet/i)).toBeInTheDocument(),
    );
  });

  it('download says the same', async () => {
    vi.spyOn(api, 'getAitoQuotePdf').mockRejectedValue(syncPending());
    render(<QuoteDownloadButton project={pending} />);
    await userEvent.click(screen.getByRole('button', { name: /download quote/i }));
    await waitFor(() =>
      expect(screen.getByText(/zoho has not confirmed the latest changes yet/i)).toBeInTheDocument(),
    );
  });

  it('any other failure keeps the document-specific message', async () => {
    vi.spyOn(api, 'getAitoQuotePdf').mockRejectedValue(new ApiError('Bad gateway', 502));
    render(<QuotePrintButton project={pending} />);
    await userEvent.click(screen.getByRole('button', { name: /print quote/i }));
    await waitFor(() => expect(screen.getByText(/could not fetch the quote pdf/i)).toBeInTheDocument());
  });
});

describe('canCreateInvoice', () => {
  it('no longer waits on a pending sync: the server pushes first', () => {
    const project = {
      column: 'finish',
      quote_id: 'E1',
      quote_invoiced: false,
      quote_sync_state: 'pending',
    } as unknown as AitoProject;
    expect(canCreateInvoice(project)).toBe(true);
  });
});
