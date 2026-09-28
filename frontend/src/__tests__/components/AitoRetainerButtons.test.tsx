import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { api } from '../../api/client';
import { RetainerDownloadButton } from '../../components/aito/RetainerDownloadButton';
import { RetainerPrintButton } from '../../components/aito/RetainerPrintButton';

describe('retainer PDF buttons', () => {
  afterEach(() => vi.restoreAllMocks());

  it('download fetches the retainer PDF pinned to the row and names the file after the number', async () => {
    const spy = vi.spyOn(api, 'getAitoRetainerPdf').mockResolvedValue(new Blob(['%PDF-'], { type: 'application/pdf' }));
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    render(<RetainerDownloadButton projectId={12} retainerId="RET-B" retainerNumber="AC-26-0031" />);

    await userEvent.click(screen.getByRole('button', { name: 'Download retainer invoice' }));

    await waitFor(() => expect(clicks).toEqual(['AC-26-0031.pdf']));
    expect(spy).toHaveBeenCalledWith(12, 'RET-B');
    expect(create).toHaveBeenCalled();
  });

  it('print is disabled with the sync tooltip while the quote sync is pending', () => {
    render(<RetainerPrintButton projectId={12} retainerId="RET-B" disabled />);
    const button = screen.getByRole('button', { name: 'Print retainer invoice' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', "Sync in progress — the document isn’t up to date yet");
  });
});
