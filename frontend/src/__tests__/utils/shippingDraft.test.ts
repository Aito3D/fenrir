import { describe, it, expect } from 'vitest';
import {
  emptyShippingDraft,
  isShippingComplete,
  shippingDraftErrors,
  shippingPayload,
  splitRecipientName,
  visibleShippingDraftErrors,
} from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';
import { defaultClientDraft } from '../../utils/clientDraft';

function draft(overrides: Partial<ShippingDraft> = {}): ShippingDraft {
  return {
    island: 'rangiroa',
    service: 'tuamotu',
    firstName: 'Jean-Pierre',
    lastName: 'DUPONT',
    countryCode: '+689',
    nationalNumber: '89645864',
    price: 3200,
    priceEdited: false,
    blurred: { island: true, firstName: true, lastName: true, phone: true },
    ...overrides,
  };
}

describe('splitRecipientName', () => {
  it('reads the house convention backwards', () => {
    // formatDisplayName writes 'Jean-Pierre DUPONT': title-cased first,
    // upper-cased last. The trailing token is the family name.
    expect(splitRecipientName('Jean-Pierre DUPONT')).toEqual({ firstName: 'Jean-Pierre', lastName: 'DUPONT' });
    expect(splitRecipientName('Marie Claire TEHEIURA')).toEqual({
      firstName: 'Marie Claire',
      lastName: 'TEHEIURA',
    });
  });

  it('treats a lone token as a family name', () => {
    expect(splitRecipientName('DUPONT')).toEqual({ firstName: '', lastName: 'DUPONT' });
  });

  it('yields nothing for an empty name', () => {
    expect(splitRecipientName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('emptyShippingDraft', () => {
  it('pre-fills from an individual client', () => {
    const client = { ...defaultClientDraft('z1', 'Jean-Pierre DUPONT'), nationalNumber: '89645864' };
    const seeded = emptyShippingDraft(client);
    expect(seeded.firstName).toBe('Jean-Pierre');
    expect(seeded.lastName).toBe('DUPONT');
    expect(seeded.nationalNumber).toBe('89645864');
    expect(seeded.island).toBe('');
  });

  it('leaves the names empty for a company, which has no person to split', () => {
    const client = { ...defaultClientDraft('z1', 'ACME SARL'), isCompany: true };
    const seeded = emptyShippingDraft(client);
    expect(seeded.firstName).toBe('');
    expect(seeded.lastName).toBe('');
  });

  it('starts with nothing blurred, so no error shows before the user leaves a field', () => {
    const seeded = emptyShippingDraft(null);
    expect(visibleShippingDraftErrors(seeded)).toEqual({
      island: null,
      firstName: null,
      lastName: null,
      phone: null,
      price: null,
    });
  });
});

describe('validation', () => {
  it('accepts a complete shipment', () => {
    expect(shippingDraftErrors(draft())).toEqual({
      island: null,
      firstName: null,
      lastName: null,
      phone: null,
      price: null,
    });
    expect(isShippingComplete(draft())).toBe(true);
  });

  it('requires every field', () => {
    expect(shippingDraftErrors(draft({ island: '' })).island).toBe('aito.ruleShippingMissingIsland');
    expect(shippingDraftErrors(draft({ firstName: ' ' })).firstName).toBe('aito.ruleShippingMissingRecipient');
    expect(shippingDraftErrors(draft({ lastName: '' })).lastName).toBe('aito.ruleShippingMissingRecipient');
    expect(shippingDraftErrors(draft({ nationalNumber: '' })).phone).toBe('aito.ruleShippingInvalidPhone');
  });

  it('rejects a malformed phone', () => {
    expect(shippingDraftErrors(draft({ nationalNumber: '12' })).phone).toBe('aito.ruleShippingInvalidPhone');
  });

  it('hides an error until the field has been left', () => {
    const untouched = draft({ island: '', blurred: { island: false, firstName: false, lastName: false, phone: false } });
    expect(visibleShippingDraftErrors(untouched).island).toBeNull();
    expect(shippingDraftErrors(untouched).island).not.toBeNull();
  });

  it('masks per field, not all or nothing', () => {
    const mixed = draft({
      island: '',
      firstName: '',
      blurred: { island: true, firstName: false, lastName: true, phone: true },
    });
    const visible = visibleShippingDraftErrors(mixed);
    // Left the island -> its error is on screen.
    expect(visible.island).toBe('aito.ruleShippingMissingIsland');
    // Never left the first name -> its error stays hidden, even though the
    // field is genuinely invalid.
    expect(visible.firstName).toBeNull();
    expect(shippingDraftErrors(mixed).firstName).toBe('aito.ruleShippingMissingRecipient');
  });

  it('requires a price once an island exists, but treats 0 as a real free shipment', () => {
    // null = no rate known and none typed yet — this is what ShippingFields
    // shows as its amber "No rate from Zoho — enter one" hint, and what the
    // server 422s on ("No rate is known for this service — supply
    // shipping_price"). Reuses that same key rather than inventing one.
    expect(shippingDraftErrors(draft({ price: null })).price).toBe('aito.shippingNoRate');
    expect(isShippingComplete(draft({ price: null }))).toBe(false);
    // A free shipment is a real, complete one — 0 is not "missing".
    expect(shippingDraftErrors(draft({ price: 0 })).price).toBeNull();
    expect(isShippingComplete(draft({ price: 0 }))).toBe(true);
    // And the ordinary case: a real Zoho-resolved rate still passes.
    expect(shippingDraftErrors(draft({ price: 3200 })).price).toBeNull();
    expect(isShippingComplete(draft({ price: 3200 }))).toBe(true);
  });

  it('rejects a negative price the server would 422 on, distinctly from a missing one', () => {
    // The server field is `ge=0` (AitoShippingInput.shipping_price) and 422s
    // on a negative figure — this is the only client-side check standing
    // between a typo like "-50" and that 422, since nothing here submits a
    // <form> for the input's `min={0}` to enforce natively.
    expect(shippingDraftErrors(draft({ price: -50 })).price).toBe('aito.shippingRateNegative');
    expect(isShippingComplete(draft({ price: -50 }))).toBe(false);
    // Distinct key from the null case, so a caller (ShippingFields,
    // CreateChecklist) can tell "nothing typed" from "typed something invalid".
    expect(shippingDraftErrors(draft({ price: -50 })).price).not.toBe(shippingDraftErrors(draft({ price: null })).price);
    // -0 is not negative — must not be flagged as though it were.
    expect(shippingDraftErrors(draft({ price: -0 })).price).toBeNull();
  });

  it('gates the missing-price error on the ISLAND having been left, not a flag of its own', () => {
    const untouched = draft({
      price: null,
      blurred: { island: false, firstName: true, lastName: true, phone: true },
    });
    expect(visibleShippingDraftErrors(untouched).price).toBeNull();
    expect(shippingDraftErrors(untouched).price).toBe('aito.shippingNoRate');

    const revealed = { ...untouched, blurred: { ...untouched.blurred, island: true } };
    expect(visibleShippingDraftErrors(revealed).price).toBe('aito.shippingNoRate');
  });
});

describe('shippingPayload', () => {
  it('rejoins the phone into the house format', () => {
    expect(shippingPayload(draft())).toEqual({
      shipping_island: 'rangiroa',
      shipping_first_name: 'Jean-Pierre',
      shipping_last_name: 'DUPONT',
      shipping_phone: '+689-89645864',
      shipping_price: 3200,
    });
  });

  it('carries a null price through as null', () => {
    expect(shippingPayload(draft({ price: null })).shipping_price).toBeNull();
  });

  it('carries a free (zero) shipment through as 0, not null', () => {
    expect(shippingPayload(draft({ price: 0 })).shipping_price).toBe(0);
  });
});
