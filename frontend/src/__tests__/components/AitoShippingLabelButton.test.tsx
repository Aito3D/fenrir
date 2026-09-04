import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ShippingLabelButton } from '../../components/aito/ShippingLabelButton';
import { api } from '../../api/client';
import type { AitoProject, AitoShippingServices } from '../../api/client';

/** A finished, shipped project — the only case the button exists for. */
const shipped = {
  id: 7,
  column: 'finish',
  description: 'Support de casque',
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

/** jsdom 25 has no Blob.text(); FileReader is the one reader it does ship. */
const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

describe('ShippingLabelButton', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing unless the project is in Finish', () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    render(<ShippingLabelButton project={{ ...shipped, column: 'print' } as AitoProject} invoiceNumber="FA-26-0001" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing when the project has no shipping', () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    render(<ShippingLabelButton project={{ ...shipped, shipping_island: null } as AitoProject} invoiceNumber="FA-26-0001" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    // No shipping means no label, so no reason to fetch the island catalogue.
    expect(api.getAitoShippingServices).not.toHaveBeenCalled();
  });

  it('prints a self-contained label document naming the recipient, island and invoice', async () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
    let printed: Blob | null = null;
    globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
      printed = blob;
      return 'blob:label';
    });
    globalThis.URL.revokeObjectURL = vi.fn();
    const print = vi.fn();
    vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({
      focus: () => {},
      print,
    } as unknown as Window);
    const user = userEvent.setup();

    render(<ShippingLabelButton project={shipped} invoiceNumber="FA-26-0001" />);
    // Wait for the catalogue so the island prints as "Bora Bora", not a
    // title-cased key.
    await waitFor(() => expect(api.getAitoShippingServices).toHaveBeenCalled());
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
    const html = await readBlob(printed as unknown as Blob);
    expect(html).toContain('Teva Tehei');
    expect(html).toContain('Bora Bora');
    expect(html).toContain('FA-26-0001');
    expect(html).toContain('contact@aito3d.fr');
  });

  it('names the fallback download after the label, not after a PDF', async () => {
    vi.spyOn(api, 'getAitoShippingServices').mockResolvedValue(SERVICES);
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

    render(<ShippingLabelButton project={shipped} invoiceNumber="FA-26-0001" />);
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
