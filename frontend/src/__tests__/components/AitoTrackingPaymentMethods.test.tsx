import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../../i18n';
import { TrackingPaymentMethods } from '../../components/aito/TrackingPaymentMethods';
import { AITO3D_BANK, AITO3D_TRANSFER_APPS } from '../../utils/aitoBankDetails';

// The tracking page speaks the shop's language; assertions are French.
beforeAll(() => i18n.changeLanguage('fr'));
afterAll(() => i18n.changeLanguage('en'));

// Same clipboard fixture as AitoTrackingLinkControl.test.tsx: force a secure
// context and define (not assign) a writeText stub, restoring the original
// descriptor afterwards so user-event's own stub never leaks between tests.
let originalClipboard: PropertyDescriptor | undefined;
beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

const pane = () => screen.getByRole('tabpanel');

describe('TrackingPaymentMethods', () => {
  it('opens on the bank transfer, one tab per method, rows in the order a transfer form asks for them', () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    const panel = screen.getByTestId('track-payment-methods');
    expect(panel).toHaveClass('animate-rise');

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Virement', ...AITO3D_TRANSFER_APPS.map((a) => a.name), 'Magasin']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tablist', { name: 'Moyen de paiement' })).toBeInTheDocument();

    // Every fact the client will type is a button that copies it; the bank's
    // name is plain text. Labels are translated, the acronyms literal.
    const buttons = within(pane()).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      "Copier l'IBAN",
      'Copier le bénéficiaire',
      'Copier le BIC',
      'Copier le motif',
      'Copier le RIB',
    ]);
    expect(within(buttons[0]).getByText('FR76 1746 9000 3120 6624 2000 041')).toBeInTheDocument();
    expect(within(buttons[1]).getByText("SARL O'SEA")).toBeInTheDocument();
    expect(within(buttons[2]).getByText('SOCBPFTXXXX')).toBeInTheDocument();
    expect(within(buttons[3]).getByText('Motif du virement')).toBeInTheDocument();
    expect(within(buttons[3]).getByText('EST-000142')).toBeInTheDocument();
    expect(within(buttons[4]).getByText('17469 00031 20662420000 41')).toBeInTheDocument();
    for (const label of ['IBAN', 'Bénéficiaire', 'BIC', 'Banque', 'RIB']) {
      expect(within(pane()).getByText(label)).toBeInTheDocument();
    }
    expect(within(pane()).getByText('Socredo').closest('button')).toBeNull();
    expect(within(panel).getByText(/Un virement peut mettre un jour ou deux/)).toBeInTheDocument();
    // The old closing line is gone.
    expect(within(panel).queryByText(/Répondez à notre message/)).not.toBeInTheDocument();
  });

  it('shows one method at a time: an app pane carries its tag and the reference as the message', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    for (const app of AITO3D_TRANSFER_APPS) {
      await userEvent.click(screen.getByRole('tab', { name: app.name }));
      expect(screen.getByRole('tab', { name: app.name })).toHaveAttribute('aria-selected', 'true');
      expect(within(pane()).getByText(`Tag ${app.name}`)).toBeInTheDocument();
      expect(within(pane()).getByRole('button', { name: `Copier le tag ${app.name}` })).toHaveTextContent(app.tag);
      expect(within(pane()).getByRole('button', { name: 'Copier le motif' })).toHaveTextContent('EST-000142');
      expect(within(pane()).getByText('Message')).toBeInTheDocument();
      expect(within(pane()).queryByText(/IBAN/)).not.toBeInTheDocument();
      expect(screen.getByText(`Depuis l'application ${app.name}, envoyez le montant du devis à ce tag.`)).toBeInTheDocument();
    }
  });

  it('the shop pane names the ways to pay and the address, with no reference to quote', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Magasin' }));
    expect(within(pane()).getByText('Carte bancaire, espèces ou chèque.')).toBeInTheDocument();
    expect(within(pane()).getByText('Adresse')).toBeInTheDocument();
    expect(within(pane()).getByText("20 Route de l'eau Royale, Arue – Tahiti")).toBeInTheDocument();
    expect(within(pane()).queryAllByRole('button')).toEqual([]);
    expect(within(pane()).queryByText('EST-000142')).not.toBeInTheDocument();
    expect(screen.getByText("À régler à l'atelier lors du retrait.")).toBeInTheDocument();
  });

  it('moves between tabs with the arrow keys, wrapping at both ends', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    const first = screen.getByRole('tab', { name: 'Virement' });
    first.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Magasin' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Magasin' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Magasin' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Home}');
    expect(first).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the reference row, uncopyable, when the quote number is unknown', () => {
    render(<TrackingPaymentMethods open reference={null} />);
    expect(within(pane()).getByText('Motif du virement')).toBeInTheDocument();
    expect(within(pane()).getByText('Votre numéro de devis').closest('button')).toBeNull();
    expect(within(pane()).queryByRole('button', { name: 'Copier le motif' })).not.toBeInTheDocument();
    expect(within(pane()).queryByText(/EST-/)).not.toBeInTheDocument();
  });

  it('does not rise while closed', () => {
    render(<TrackingPaymentMethods open={false} reference={null} />);
    expect(screen.getByTestId('track-payment-methods')).not.toHaveClass('animate-rise');
  });

  it('copies a row on press and confirms briefly on that row only', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);

    const iban = screen.getByRole('button', { name: "Copier l'IBAN" });
    await userEvent.click(iban);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(AITO3D_BANK.iban);
    await waitFor(() => expect(iban).toHaveTextContent('Copié'));
    expect(iban).toHaveAttribute('data-copied');
    // The other rows keep their idle state.
    const motif = screen.getByRole('button', { name: 'Copier le motif' });
    expect(motif).not.toHaveTextContent('Copié');

    await userEvent.click(motif);
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('EST-000142');
    await waitFor(() => expect(motif).toHaveTextContent('Copié'));
    // Only one confirmation at a time: pressing another row resets the first.
    expect(iban).not.toHaveTextContent('Copié');

    // The tag rows copy too, from their own pane.
    await userEvent.click(screen.getByRole('tab', { name: 'Revolut' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copier le tag Revolut' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('@paulteloe');

    // The confirmation fades on its own after the hold.
    await waitFor(() => expect(screen.queryByText('Copié')).not.toBeInTheDocument(), { timeout: 3000 });
  });
});
