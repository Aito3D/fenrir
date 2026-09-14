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

describe('TrackingPaymentMethods', () => {
  it('lists the bank transfer details, the app transfers and the in-shop options', () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    const panel = screen.getByTestId('track-payment-methods');
    expect(panel).toHaveClass('animate-rise');

    // The transfer reference is the quote number, spelled out when known.
    expect(within(panel).getByText(/Indiquez le numéro de devis EST-000142/)).toBeInTheDocument();

    const transfer = within(panel).getByRole('group', { name: 'Virement bancaire' });
    expect(within(transfer).getByText("SARL O'SEA")).toBeInTheDocument();
    expect(within(transfer).getByText('Socredo')).toBeInTheDocument();
    expect(within(transfer).getByText('FR76 1746 9000 3120 6624 2000 041')).toBeInTheDocument();
    expect(within(transfer).getByText('SOCBPFTXXXX')).toBeInTheDocument();
    expect(within(transfer).getByText('17469 00031 20662420000 41')).toBeInTheDocument();
    // Labels: the bank ones are literal acronyms, the rest translated.
    for (const label of ['Bénéficiaire', 'Banque', 'IBAN', 'BIC', 'RIB']) {
      expect(within(transfer).getByText(label)).toBeInTheDocument();
    }
    expect(within(transfer).getByText(/Un virement peut mettre un jour ou deux/)).toBeInTheDocument();

    for (const app of AITO3D_TRANSFER_APPS) {
      const group = within(panel).getByRole('group', { name: `Virement ${app.name}` });
      expect(within(group).getByText(app.tag)).toBeInTheDocument();
      expect(within(group).getByText('Bénéficiaire (tag)')).toBeInTheDocument();
    }

    const shop = within(panel).getByRole('group', { name: 'Au magasin' });
    expect(within(shop).getByText('Carte bancaire ou espèces.')).toBeInTheDocument();
    expect(within(panel).getByText('Répondez à notre message pour toute question.')).toBeInTheDocument();
  });

  it('falls back to a generic reference line when the quote number is unknown', () => {
    render(<TrackingPaymentMethods open reference={null} />);
    const panel = screen.getByTestId('track-payment-methods');
    expect(within(panel).getByText(/Indiquez le numéro de votre devis en référence/)).toBeInTheDocument();
    expect(within(panel).queryByText(/EST-/)).not.toBeInTheDocument();
  });

  it('does not rise while closed', () => {
    render(<TrackingPaymentMethods open={false} reference={null} />);
    expect(screen.getByTestId('track-payment-methods')).not.toHaveClass('animate-rise');
  });

  it('copies the IBAN and each app tag, confirming briefly on the pressed button only', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);

    const copyIban = screen.getByRole('button', { name: "Copier l'IBAN" });
    await userEvent.click(copyIban);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(AITO3D_BANK.iban);
    await waitFor(() => expect(copyIban).toHaveTextContent('Copié'));
    // The other copy buttons keep their idle label.
    const copyDeblock = screen.getByRole('button', { name: 'Copier le tag Deblock' });
    expect(copyDeblock).toHaveTextContent('Copier');

    await userEvent.click(copyDeblock);
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('@paul3482');
    await waitFor(() => expect(copyDeblock).toHaveTextContent('Copié'));
    // Only one confirmation at a time: pressing another button resets the first.
    expect(copyIban).toHaveTextContent('Copier');

    await userEvent.click(screen.getByRole('button', { name: 'Copier le tag Revolut' }));
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('@paulteloe');

    // The confirmation fades on its own after the hold.
    await waitFor(() => expect(screen.queryByText('Copié')).not.toBeInTheDocument(), { timeout: 3000 });
  });
});
