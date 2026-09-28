import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../utils';
import { DocumentRow } from '../../components/aito/DocumentRow';

function row(over: Partial<Parameters<typeof DocumentRow>[0]> = {}) {
  return render(
    <DocumentRow
      label="Invoice"
      number="FA-26-4100"
      numberTitle="Issued 2026-09-27 · due 2026-10-12"
      status={{ text: 'Unpaid', toneClass: 'text-status-warning' }}
      amount="35 000 FCFP"
      booksUrl="https://books.zoho.eu/app/org1#/invoices/inv-1"
      booksLabel="Open in Zoho Books"
      print={<button type="button" aria-label="Print invoice" />}
      download={<button type="button" aria-label="Download invoice" />}
      send={<button type="button" aria-label="Send invoice" />}
      testId="doc-invoice"
      {...over}
    />,
  );
}

describe('DocumentRow', () => {
  it('shows label, number with its tooltip, status in tone, and the amount', () => {
    row();
    const node = screen.getByTestId('doc-invoice');
    expect(within(node).getByText('Invoice')).toBeInTheDocument();
    expect(within(node).getByText('FA-26-4100')).toHaveAttribute('title', 'Issued 2026-09-27 · due 2026-10-12');
    expect(within(node).getByText('Unpaid')).toHaveClass('text-status-warning');
    expect(within(node).getByText(/35 000 FCFP/)).toBeInTheDocument();
    // The number is plain text now: Books is reached through the row's last icon.
    expect(within(node).queryByRole('link', { name: /FA-26-4100/ })).toBeNull();
  });

  it('orders the cluster print, download, send, Books', () => {
    row();
    const node = screen.getByTestId('doc-invoice');
    const names = [...node.querySelectorAll('button, a')].map((el) => el.getAttribute('aria-label'));
    expect(names).toEqual(['Print invoice', 'Download invoice', 'Send invoice', 'Open in Zoho Books']);
    const books = within(node).getByRole('link', { name: 'Open in Zoho Books' });
    expect(books).toHaveAttribute('href', 'https://books.zoho.eu/app/org1#/invoices/inv-1');
    expect(books).toHaveAttribute('rel', 'noopener noreferrer');
    expect(books).toHaveAttribute('target', '_blank');
  });

  it('omits send and Books when they are not given', () => {
    row({ send: undefined, booksUrl: null });
    const node = screen.getByTestId('doc-invoice');
    expect(within(node).queryByRole('button', { name: 'Send invoice' })).toBeNull();
    expect(within(node).queryByRole('link')).toBeNull();
  });

  it('renders line two with the cluster only when there is no status and no amount', () => {
    row({ status: null, amount: null });
    const node = screen.getByTestId('doc-invoice');
    expect(within(node).queryByText('Unpaid')).toBeNull();
    expect(within(node).getByRole('button', { name: 'Print invoice' })).toBeInTheDocument();
  });
});
