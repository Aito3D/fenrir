import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
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

  it('tweens the pane wrap height between two real sizes, then clears the inline height once the transition ends', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    const wrap = pane().parentElement as HTMLElement;

    // jsdom always reports 0 for offsetHeight/scrollHeight, which makes
    // `to === from` (0 === 0) true on every real click — stub both to
    // distinct, non-zero values so the tween body actually runs: the
    // "before" pane's offsetHeight (read synchronously by `select`, before
    // the method switches) and the "after" pane's scrollHeight (read by the
    // layout effect once the new pane has rendered).
    Object.defineProperty(wrap, 'offsetHeight', { get: () => 120, configurable: true });
    Object.defineProperty(wrap, 'scrollHeight', { get: () => 200, configurable: true });
    const heightSets = vi.spyOn(wrap.style, 'height', 'set');

    await userEvent.click(screen.getByRole('tab', { name: 'Magasin' }));

    // Two synchronous writes: the captured "from" height first (so the pane
    // starts the transition at its old size), then the "to" height (so the
    // CSS transition animates towards it).
    expect(heightSets.mock.calls.map((c) => c[0])).toEqual(['120px', '200px']);
    expect(wrap.style.height).toBe('200px');

    fireEvent(wrap, new Event('transitionend'));
    expect(wrap.style.height).toBe('');

    heightSets.mockRestore();
  });

  it('does not tween the pane height when the before/after sizes are equal (jsdom default)', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    const wrap = pane().parentElement as HTMLElement;
    const heightSets = vi.spyOn(wrap.style, 'height', 'set');

    await userEvent.click(screen.getByRole('tab', { name: 'Magasin' }));

    expect(heightSets).not.toHaveBeenCalled();
    expect(wrap.style.height).toBe('');

    heightSets.mockRestore();
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

  it('shows no confirmation when the clipboard write fails and the execCommand fallback also fails', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('blocked'));
    // Simulates the execCommand fallback also failing (e.g. Firefox on a
    // plain-HTTP LAN origin), so copyTextToClipboard resolves to false —
    // mirrors AitoTrackingLinkControl.test.tsx's clipboard-failure case.
    const originalExecCommand = document.execCommand;
    document.execCommand = vi.fn().mockReturnValue(false);

    render(<TrackingPaymentMethods open reference="EST-000142" />);
    const iban = screen.getByRole('button', { name: "Copier l'IBAN" });
    await userEvent.click(iban);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(AITO3D_BANK.iban);
    // Wait for the whole fallback chain (rejected writeText, then the
    // execCommand fallback) to settle before asserting nothing changed.
    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'));
    // No confirmation anywhere: neither the row's own text nor the live
    // region that screen readers pick up.
    expect(iban).not.toHaveTextContent('Copié');
    expect(iban).not.toHaveAttribute('data-copied');
    expect(screen.queryByText('Copié')).not.toBeInTheDocument();

    document.execCommand = originalExecCommand;
  });
});

describe('TrackingPaymentMethods — shop hand-off', () => {
  it('the shop pane offers a way to the shop panel when the page provides one, passing the pressed button', async () => {
    const onFindShop = vi.fn();
    render(<TrackingPaymentMethods open reference="EST-000142" onFindShop={onFindShop} />);
    expect(screen.queryByRole('button', { name: 'Voir où nous trouver' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Magasin' }));
    const link = screen.getByRole('button', { name: 'Voir où nous trouver' });
    await userEvent.click(link);
    expect(onFindShop).toHaveBeenCalledWith(link);
  });

  it('without a hand-off the shop pane stays as it was', async () => {
    render(<TrackingPaymentMethods open reference="EST-000142" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Magasin' }));
    expect(screen.queryByRole('button', { name: 'Voir où nous trouver' })).not.toBeInTheDocument();
  });
});
