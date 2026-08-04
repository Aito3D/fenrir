import { DEFAULT_COUNTRY_CODE, formatPhone, validatePhone } from './clientDraft';
import type { ClientDraft } from './clientDraft';

/** The shipping half of the Aito new-project form, as one value.
 *
 *  Mirrors `ClientDraft`, including its validity-vs-visibility split: a field
 *  only reports its error once it has been LEFT (`blurred`), so nothing flashes
 *  red on the first keystroke, and clicking Create is what reveals the rest.
 *
 *  `service` is derived from `island` against the table fetched from
 *  `/aito/shipping/services` — it is carried here only so the form can show
 *  the matched service without a re-lookup. The SERVER derives its own; this
 *  value is never trusted over the wire. */
export interface ShippingDraft {
  /** '' until an island is chosen. This field is what decides whether a
   *  shipment exists at all, on this side and on the server's. */
  island: string;
  service: string;
  firstName: string;
  lastName: string;
  countryCode: string;
  nationalNumber: string;
  /** null = no rate known and none typed yet. 0 is a real, free shipment. */
  price: number | null;
  /** The operator overrode the Zoho rate, so the reset control is offered. */
  priceEdited: boolean;
  blurred: { island: boolean; firstName: boolean; lastName: boolean; phone: boolean };
}

export interface ShippingDraftErrors {
  island: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

/** Split a client's display name into a recipient first/last pair.
 *
 *  The directory's house convention (`formatDisplayName`) writes a person as
 *  `Jean-Pierre DUPONT` — title-cased given names, upper-cased family name —
 *  so the LAST whitespace-separated token is the family name. A single token
 *  is a family name with no given name, not the reverse. */
export function splitRecipientName(displayName: string): { firstName: string; lastName: string } {
  const parts = (displayName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

/** A fresh shipment, pre-filled from the client where that makes sense.
 *
 *  A COMPANY contact has no person to split, so the names start empty and the
 *  operator types whoever actually receives the parcel — which is the correct
 *  behaviour for a business anyway. Pre-filled values are a starting point,
 *  never a binding: editing them never writes back to the Zoho contact. */
export function emptyShippingDraft(client: ClientDraft | null): ShippingDraft {
  const person = client && !client.isCompany ? splitRecipientName(client.name) : { firstName: '', lastName: '' };
  return {
    island: '',
    service: '',
    firstName: person.firstName,
    lastName: person.lastName,
    countryCode: client?.countryCode ?? DEFAULT_COUNTRY_CODE,
    nationalNumber: client?.nationalNumber ?? '',
    price: null,
    priceEdited: false,
    blurred: { island: false, firstName: false, lastName: false, phone: false },
  };
}

/** Pure validity, independent of what has been blurred. Every field is
 *  required once a shipment exists — the four of them are what the freight
 *  desk asks for, and a parcel missing any one of them cannot be handed over.
 *  Returns i18n keys so this stays testable without i18n. */
export function shippingDraftErrors(draft: ShippingDraft): ShippingDraftErrors {
  const phone = { countryCode: draft.countryCode, nationalNumber: draft.nationalNumber };
  return {
    island: draft.island.trim() ? null : 'aito.ruleShippingMissingIsland',
    firstName: draft.firstName.trim() ? null : 'aito.ruleShippingMissingRecipient',
    lastName: draft.lastName.trim() ? null : 'aito.ruleShippingMissingRecipient',
    // An empty number passes `validatePhone` (the client's phone is optional),
    // so emptiness is checked here — for a shipment it is not optional.
    phone: draft.nationalNumber.trim() && validatePhone(phone) === null ? null : 'aito.ruleShippingInvalidPhone',
  };
}

/** What the form should currently show and gate Create on. Same masking rule
 *  as `visibleClientDraftErrors`. */
export function visibleShippingDraftErrors(draft: ShippingDraft): ShippingDraftErrors {
  const errors = shippingDraftErrors(draft);
  return {
    island: draft.blurred.island ? errors.island : null,
    firstName: draft.blurred.firstName ? errors.firstName : null,
    lastName: draft.blurred.lastName ? errors.lastName : null,
    phone: draft.blurred.phone ? errors.phone : null,
  };
}

export function isShippingComplete(draft: ShippingDraft): boolean {
  return Object.values(shippingDraftErrors(draft)).every((error) => error === null);
}

/** The five fields POST /aito/ and PATCH /aito/{id} accept. `shipping_service`
 *  is deliberately absent: the server derives it from the island and would
 *  silently ignore the field, implying a choice the client doesn't have.
 *
 *  CONTRACT: changing a shipment's island to one served by a DIFFERENT service
 *  re-derives the service server-side but KEEPS the stored price. Any caller
 *  that changes the island MUST resend `shipping_price` (reseeded from the new
 *  service's rate, unless the operator hand-edited it) — otherwise the
 *  shipment bills the previous service's rate under the new service's name. */
export function shippingPayload(draft: ShippingDraft) {
  return {
    shipping_island: draft.island,
    shipping_first_name: draft.firstName.trim(),
    shipping_last_name: draft.lastName.trim(),
    shipping_phone: formatPhone({ countryCode: draft.countryCode, nationalNumber: draft.nationalNumber }),
    shipping_price: draft.price,
  };
}
