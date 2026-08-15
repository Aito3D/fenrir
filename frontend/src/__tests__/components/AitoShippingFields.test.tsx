import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ShippingFields } from '../../components/aito/ShippingFields';
import { emptyShippingDraft } from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';
import type { AitoShippingService } from '../../api/client';
import i18n from '../../i18n';

// Two services, mirroring AitoIslandCombobox.test.tsx's fixture, are load-
// bearing here: with only one service in the table, an island pick can never
// cross a service boundary, so `selectIsland`'s price-reseed line — the one
// thing standing between an island change and billing the wrong service's
// rate under the new service's name — is never actually exercised.
const SERVICES: AitoShippingService[] = [
  {
    key: 'tuamotu',
    name: 'Livraison Avion Tuamotu',
    rate: 3200,
    islands: [{ key: 'rangiroa', label: 'Rangiroa' }],
  },
  {
    key: 'australes',
    name: 'Livraison Avion Australes',
    rate: 4100,
    islands: [{ key: 'rurutu', label: 'Rurutu' }],
  },
];

// ShippingFields is value-in/onChange-out and owns no shipment state of its
// own (see its docstring) — so, like every real caller (the drawer, the
// panel's edit mode), a test has to feed onChange's result back in as the
// next value or the component simply cannot show anything that only exists
// after an update: a freshly-picked island, a freshly-blurred field. A
// static `render` with a `vi.fn()` onChange leaves the component permanently
// uncontrolled, which used to push the component itself to grow a local
// mirror of `blurred` just to satisfy the test — exactly the kind of
// internal state it must not own. This harness is what makes that
// unnecessary: it is a closer match to production than a bare render would
// be, not just a testing convenience.
function Harness({
  initial,
  services = SERVICES,
  catalogueResolved = true,
  onChangeSpy,
}: {
  initial: ShippingDraft;
  services?: AitoShippingService[];
  catalogueResolved?: boolean;
  onChangeSpy?: (next: ShippingDraft) => void;
}) {
  const [value, setValue] = useState<ShippingDraft>(initial);
  return (
    <ShippingFields
      value={value}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
      services={services}
      catalogueResolved={catalogueResolved}
      currency="XPF"
    />
  );
}

function setup(overrides: Partial<ShippingDraft> = {}) {
  const onChange = vi.fn();
  const value = { ...emptyShippingDraft(null), ...overrides };
  render(<Harness initial={value} onChangeSpy={onChange} />);
  return { onChange, value };
}

// `getByLabelText(/rate/i)` is ambiguous once the reset button is on screen:
// its accessible name is "Back to the Zoho rate", which also matches /rate/i.
// The old, uncontrolled test never rendered that button mid-interaction, so
// the ambiguity stayed hidden. A `type=number` input has an implicit
// `spinbutton` role, which the button does not share, so this stays
// unambiguous under the controlled harness.
const getRateInput = () => screen.getByRole('spinbutton', { name: 'Rate' });

describe('ShippingFields', () => {
  it('resolves the service and seeds the price when an island is picked', async () => {
    const { onChange } = setup();
    await userEvent.click(screen.getByRole('combobox', { name: /destination island/i }));
    await userEvent.click(screen.getByRole('option', { name: 'Rangiroa' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ island: 'rangiroa', service: 'tuamotu', price: 3200, priceEdited: false }),
    );
  });

  it('reseeds the price from the new service when the island crosses a service boundary', async () => {
    // Starting priced at Tuamotu's rate, untouched by the operator — this is
    // the case the backend depends on the client to handle: it re-derives
    // `service` from `island` but KEEPS whatever price is sent, so a client
    // that fails to reseed here would bill Australes at Tuamotu's rate.
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 3200, priceEdited: false });
    await userEvent.click(screen.getByRole('combobox', { name: /destination island/i }));
    await userEvent.click(screen.getByRole('option', { name: 'Rurutu' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ island: 'rurutu', service: 'australes', price: 4100, priceEdited: false }),
    );
    // Both halves matter: the reported service and the rendered price must
    // agree, or the screen and the payload tell two different stories.
    expect(screen.getByText('Livraison Avion Australes')).toBeInTheDocument();
    expect(getRateInput()).toHaveValue(4100);
  });

  it('keeps a hand-typed price when the island crosses a service boundary, but still updates the matched service', async () => {
    // The guard half of the same rule: a price the operator deliberately
    // overrode must survive an island change untouched, even though the
    // service it is now billed under has changed.
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 9999, priceEdited: true });
    await userEvent.click(screen.getByRole('combobox', { name: /destination island/i }));
    await userEvent.click(screen.getByRole('option', { name: 'Rurutu' }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ island: 'rurutu', service: 'australes', price: 9999, priceEdited: true }),
    );
    expect(screen.getByText('Livraison Avion Australes')).toBeInTheDocument();
    expect(getRateInput()).toHaveValue(9999);
  });

  it('shows the matched service and its rate', () => {
    setup({ island: 'rangiroa', service: 'tuamotu', price: 3200 });
    expect(screen.getByText('Livraison Avion Tuamotu')).toBeInTheDocument();
    expect(getRateInput()).toHaveValue(3200);
  });

  // The Zoho rate line must follow the app's own language, like every other
  // formatted number in the feature (CardView, PanelAgeStat, ProjectDetailPanel,
  // ImportQuoteDrawer all pass `i18n.language`) — not the browser/JSDOM default.
  // `en` and `fr` group thousands differently (comma vs. a narrow no-break
  // space), so switching to `fr` and asserting the French grouping is what
  // actually catches a regression back to a bare, argument-less `toLocaleString()`.
  //
  // The language switch is scoped to this single test via try/finally rather
  // than a separate `afterEach`: an `afterEach` only restores 'en' once
  // control reaches it, which a throw in a `beforeEach`, or a future edit
  // that moves `changeLanguage` outside this test's own try/finally, could
  // skip — leaking 'fr' into every sibling test that shares this file or
  // worker. Capturing and restoring the previous language locally, in the
  // one test that needs it, survives that failure mode. (No other
  // locale-sensitive Aito test — CardView, PanelAgeStat, ProjectDetailPanel,
  // ImportQuoteDrawer — actually switches `i18n.language`; they only format
  // with whatever it already is, so there is no existing switch-and-restore
  // convention to match here.)
  it('renders the French thousands grouping once the language is switched to fr, and restores it afterwards', async () => {
    const previousLanguage = i18n.language;
    try {
      await act(async () => {
        await i18n.changeLanguage('fr');
      });
      setup({ island: 'rangiroa', service: 'tuamotu', price: 3200 });
      const expectedRate = (3200).toLocaleString('fr');
      expect(expectedRate).not.toBe((3200).toLocaleString('en'));
      // testing-library's default text matcher collapses runs of Unicode
      // whitespace (French grouping uses a narrow no-break space) down to a
      // plain ASCII space before comparing, so the separator itself must be
      // matched with `\s+` rather than the literal codepoint `toLocaleString`
      // produced.
      const rateAsFlexiblePattern = expectedRate.replace(/\s+/gu, '\\s+');
      expect(screen.getByText(new RegExp(`${rateAsFlexiblePattern}\\s*XPF`))).toBeInTheDocument();
    } finally {
      await act(async () => {
        await i18n.changeLanguage(previousLanguage);
      });
    }
  });

  it('does not leak the French language switch into a sibling test', () => {
    // Proves the restore above is real rather than merely asserted: if the
    // previous test's `finally` had not run (or a future edit dropped it),
    // this component would still be rendering with French thousands
    // grouping (a narrow no-break space) and this English-grouping
    // assertion would fail.
    setup({ island: 'rangiroa', service: 'tuamotu', price: 3200 });
    expect(screen.getByText(/3,200\s*XPF/)).toBeInTheDocument();
  });

  it('offers a reset once the price is edited, and no reset before', async () => {
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 3200 });
    expect(screen.queryByRole('button', { name: /back to the zoho rate/i })).not.toBeInTheDocument();
    expect(screen.queryByText('edited')).not.toBeInTheDocument();
    await userEvent.clear(getRateInput());
    await userEvent.type(getRateInput(), '5400');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ priceEdited: true }));
  });

  it('shows the edited marker once the price is edited', () => {
    setup({ island: 'rangiroa', service: 'tuamotu', price: 5400, priceEdited: true });
    expect(screen.getByText('edited')).toBeInTheDocument();
  });

  it('restores the Zoho rate on reset', async () => {
    const { onChange } = setup({ island: 'rangiroa', service: 'tuamotu', price: 5400, priceEdited: true });
    await userEvent.click(screen.getByRole('button', { name: /back to the zoho rate/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ price: 3200, priceEdited: false }));
    // The harness feeds the update back in, so the rendered field itself
    // must now show the restored value, not just the onChange payload.
    expect(getRateInput()).toHaveValue(3200);
  });

  it('asks for a price when Zoho gave none', () => {
    render(
      <ShippingFields
        value={{ ...emptyShippingDraft(null), island: 'rangiroa', service: 'tuamotu' }}
        onChange={vi.fn()}
        services={[{ ...SERVICES[0], rate: null }]}
        catalogueResolved={false}
        currency="XPF"
      />,
    );
    expect(screen.getByText(/no rate from zoho/i)).toBeInTheDocument();
  });

  it('warns that shipping is unavailable while the catalogue has not resolved, and not once it has', () => {
    // Distinct from the amber "no rate from Zoho" line asserted above: that
    // one is per-service (the catalogue answered but carried no rate); this
    // one is the whole-form aito.shippingUnavailable warning for a catalogue
    // that never resolved at all.
    const { unmount } = render(<Harness initial={emptyShippingDraft(null)} catalogueResolved={false} />);
    expect(screen.getByText(/shipping services are unavailable while zoho is unreachable/i)).toBeInTheDocument();
    unmount();

    setup();
    expect(screen.queryByText(/shipping services are unavailable/i)).not.toBeInTheDocument();
  });

  it('normalizes a hand-typed recipient on blur — title-cased first name, upper-cased last name', async () => {
    // Same casing convention contact-derived recipients already carry
    // (formatDisplayName): the first name's blur runs titleCaseSegments, the
    // last name's blur trims and upper-cases.
    setup();
    const first = screen.getByLabelText(/recipient first name/i);
    await userEvent.type(first, 'jean-pierre');
    await userEvent.tab();
    expect(first).toHaveValue('Jean-Pierre');

    const last = screen.getByLabelText(/recipient last name/i);
    await userEvent.type(last, 'dupont');
    await userEvent.tab();
    expect(last).toHaveValue('DUPONT');
  });

  it('caps both name inputs at the server limit of 100 characters', () => {
    // Mirrors AitoShippingInput's 100-char columns — without the client-side
    // cap the only signal for breaching it is a 422 behind a generic
    // "save failed" toast.
    setup();
    expect(screen.getByLabelText(/recipient first name/i)).toHaveAttribute('maxlength', '100');
    expect(screen.getByLabelText(/recipient last name/i)).toHaveAttribute('maxlength', '100');
  });

  it('shows an error only after a field has been left', async () => {
    setup({ firstName: '' });
    expect(screen.queryByText(/recipient name missing/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/recipient first name/i));
    await userEvent.tab();
    expect(await screen.findByText(/recipient name missing/i)).toBeInTheDocument();
  });

  it('flags a hand-typed negative rate in the field itself, and clears the flag once corrected', async () => {
    // The field only appears after an island is picked (selectIsland sets
    // blurred.island true as one atomic action), so this needs no separate
    // blur — same as every other assertion in this file that types into the
    // rate input directly.
    // `blurred.island: true`, matching what `selectIsland` always sets as one
    // atomic action the moment a real operator picks an island — without it
    // `visibleShippingDraftErrors` would mask the price error regardless of
    // what is typed, and this test would prove nothing.
    setup({
      island: 'rangiroa',
      service: 'tuamotu',
      price: 3200,
      blurred: { island: true, firstName: false, lastName: false, phone: false },
    });
    // fireEvent.change, not userEvent.type: a `type="number"` input's value
    // sanitization runs per keystroke in jsdom, and typing "-" then "5" then
    // "0" character-by-character (userEvent.type's usual idiom) leaves the
    // DOM value empty mid-sequence — this sets the full string in one React
    // change event, the same as a paste, which is what an operator hand-
    // editing a figure this small (one or two digits) would realistically do.
    fireEvent.change(getRateInput(), { target: { value: '-50' } });
    expect(await screen.findByText(/cannot be negative/i)).toBeInTheDocument();
    expect(getRateInput()).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(getRateInput(), { target: { value: '50' } });
    expect(screen.queryByText(/cannot be negative/i)).not.toBeInTheDocument();
    expect(getRateInput()).not.toHaveAttribute('aria-invalid');
  });

  it('does not duplicate the "no rate" hint under the field when the price is merely empty, not negative', () => {
    // `errors.price` is also `aito.shippingNoRate` for a null price, which
    // the amber "No rate from Zoho" line (rendered above, per-service) already
    // covers when Zoho gave none — this proves the field-level message stays
    // scoped to the negative case and does not fire a second copy of that
    // same text next to the input.
    render(
      <ShippingFields
        value={{ ...emptyShippingDraft(null), island: 'rangiroa', service: 'tuamotu', blurred: { island: true, firstName: false, lastName: false, phone: false } }}
        onChange={vi.fn()}
        services={[{ ...SERVICES[0], rate: null }]}
        catalogueResolved={true}
        currency="XPF"
      />,
    );
    expect(screen.getAllByText(/no rate from zoho/i)).toHaveLength(1);
    expect(getRateInput()).not.toHaveAttribute('aria-invalid');
  });

  it('reports the reveal upward, not just locally: blurring first name shows the error and tells the caller', async () => {
    const { onChange } = setup({ firstName: '' });
    await userEvent.click(screen.getByLabelText(/recipient first name/i));
    await userEvent.tab();
    expect(await screen.findByText(/recipient name missing/i)).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ blurred: expect.objectContaining({ firstName: true }) }),
    );
  });
});
