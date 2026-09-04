import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ShippingLabelButton } from '../../components/aito/ShippingLabelButton';
import { api } from '../../api/client';
import type { AitoInvoice, AitoProject, AitoShippingServices } from '../../api/client';

/** A finished, shipped, invoiced project — the case the button is built for. */
const shipped = {
  id: 7,
  column: 'finish',
  description: 'Support de casque',
  quote_id: 'EST-9',
  quote_number: 'QT-00412',
  quote_invoiced: true,
  quote_sync_state: 'locked',
  shipping_island: 'bora-bora',
  shipping_service: 'societe',
  shipping_service_name: 'Livraison Avion Société',
  shipping_first_name: 'Teva',
  shipping_last_name: 'Tehei',
  shipping_phone: '+689-87755669',
} as unknown as AitoProject;

const SERVICES: AitoShippingServices = {
  catalogue_resolved: true,
  services: [{ key: 'societe', name: 'Livraison Avion Société', rate: 1500, islands: [{ key: 'bora-bora', label: 'Bora Bora' }] }],
};

const INVOICE: AitoInvoice = {
  id: 'inv-1',
  number: 'FA-26-0001',
  date: '2026-08-03',
  due_date: '2026-08-17',
  total: 18350,
  balance: 0,
  currency_code: 'XPF',
  status: 'paid',
  url: 'https://books.zoho.eu/app/org1#/invoices/inv-1',
  invoice_count: 1,
};

/** jsdom 25 has no Blob.text(); FileReader is the one reader it does ship. */
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

/** Click print, let the hidden iframe "load", and hand back the printed
 *  document. Stubs the browser pieces jsdom lacks. */
async function printAndRead(print = vi.fn()): Promise<string> {
  let printed: Blob | null = null;
  globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
    printed = blob;
    return 'blob:label';
  });
  globalThis.URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
    focus: () => {},
    print,
  } as unknown as Window);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /print shipping label/i }));
  let iframe: HTMLIFrameElement | null = null;
  await waitFor(() => {
    iframe = document.querySelector('iframe');
    expect(iframe).not.toBeNull();
  });
  expect((iframe as unknown as HTMLIFrameElement).src).toContain('blob:label');
  fireEvent.load(iframe as unknown as HTMLIFrameElement);
  expect(print).toHaveBeenCalledTimes(1);
  expect(printed).not.toBeNull();
  expect((printed as unknown as Blob).type).toBe('text/html');
  return readBlob(printed as unknown as Blob);
}

describe('ShippingLabelButton', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing unless the project is in Finish', () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    render(<ShippingLabelButton project={{ ...shipped, column: 'print' } as AitoProject} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing when the project has no shipping', () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    render(<ShippingLabelButton project={{ ...shipped, shipping_island: null } as AitoProject} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // No shipping means no label, so no reason to fetch anything for one.
    expect(api.getAitoShippingServices).not.toHaveBeenCalled();
    expect(api.getAitoInvoice).not.toHaveBeenCalled();
  });

  it('prints a self-contained label naming the recipient, island and the invoice number', async () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<ShippingLabelButton project={shipped} />);
    // Both lookups settle before printing so the island prints as "Bora
    // Bora", not a title-cased key, and the reference is the invoice.
    await waitFor(() => expect(api.getAitoShippingServices).toHaveBeenCalled());
    await waitFor(() => expect(api.getAitoInvoice).toHaveBeenCalledWith(7));

    const html = await printAndRead();
    expect(html).toContain('Teva Tehei');
    expect(html).toContain('Bora Bora');
    expect(html).toContain('FA-26-0001');
    expect(html).toContain('contact@aito3d.fr');
  });

  it('falls back to the quote number as reference when nothing has been invoiced', async () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);

    render(<ShippingLabelButton project={{ ...shipped, quote_invoiced: false } as AitoProject} />);
    await waitFor(() => expect(api.getAitoShippingServices).toHaveBeenCalled());

    const html = await printAndRead();
    expect(html).toContain('QT-00412');
    expect(html).not.toContain('FA-26-0001');
    // Same gate as the Invoice card: a managed, un-invoiced project costs
    // no request to Books.
    expect(api.getAitoInvoice).not.toHaveBeenCalled();
  });

  it('prints from a hidden iframe the size of a page, not a 0×0 one', async () => {
    // Chrome scales an iframe print to fit the frame's own viewport, so a
    // 0×0 frame printed the label at a sixth of its size in the top-left
    // corner of an otherwise blank A4. The frame stays out of sight by
    // position, not by size.
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    render(<ShippingLabelButton project={shipped} />);
    await waitFor(() => expect(api.getAitoInvoice).toHaveBeenCalled());

    await printAndRead();
    const iframe = document.querySelector('iframe') as HTMLIFrameElement;
    expect(iframe.style.width).toBe('210mm');
    expect(iframe.style.height).toBe('297mm');
    expect(iframe.style.visibility).toBe('hidden');
    expect(parseInt(iframe.style.left, 10)).toBeLessThan(0);
  });

  it('is an icon-only header cell that keeps its accessible name', () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    render(<ShippingLabelButton project={shipped} />);
    const button = screen.getByRole('button', { name: /print shipping label/i });
    expect(button).toHaveTextContent('');
    expect(button).toHaveAttribute('title', 'Print shipping label');
  });

  it('names the fallback download after the label and its reference, not after a PDF', async () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    vi.spyOn(api, 'getAitoInvoice').mockResolvedValue(INVOICE);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:label');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
      focus: () => {},
      print: () => {
        throw new Error('not supported');
      },
    } as unknown as Window);
    vi.spyOn(window, 'open').mockReturnValue(null);
    let clickedDownload = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedDownload = this.download;
    });
    const user = userEvent.setup();

    render(<ShippingLabelButton project={shipped} />);
    await waitFor(() => expect(api.getAitoInvoice).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /print shipping label/i }));
    let iframe: HTMLIFrameElement | null = null;
    await waitFor(() => {
      iframe = document.querySelector('iframe');
      expect(iframe).not.toBeNull();
    });
    fireEvent.load(iframe as unknown as HTMLIFrameElement);

    await waitFor(() => expect(clickedDownload).toBe('etiquette-FA-26-0001.html'));
  });
});
