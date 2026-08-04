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
    });
  });
});

describe('validation', () => {
  it('accepts a complete shipment', () => {
    expect(shippingDraftErrors(draft())).toEqual({ island: null, firstName: null, lastName: null, phone: null });
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
