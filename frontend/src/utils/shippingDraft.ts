import { DEFAULT_COUNTRY_CODE, formatPhone, titleCaseSegments, validatePhone } from './clientDraft';
import type { ClientDraft } from './clientDraft';
import type { AitoShippingService } from '../api/client';

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
  /** null price ("no rate known and none typed yet") is an error; 0 is a
   *  real, free shipment and stays valid. Reuses `aito.shippingNoRate` — the
   *  same key `ShippingFields` already shows as its amber "enter one" hint —
   *  rather than a new key, so the field's own message and the checklist's
   *  never say two different things about the same missing rate. A negative
   *  price gets its own key (`aito.shippingRateNegative`): the server field
   *  is `ge=0` (backend/app/schemas/aito.py), and nothing here submits a
   *  `<form>`, so `min={0}` on the input never runs native validation — this
   *  is the only thing standing between a typo like "-50" and a 422 behind
   *  the generic "save failed" toast. */
  price: string | null;
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
 *  never a binding: editing them never writes back to the Zoho contact.
 *
 *  The parameter is a `Pick` of `ClientDraft` rather than the draft itself:
 *  the create drawer has a live draft to hand over, but `ShippingCard` on the
 *  detail panel has only the project's stored `client_*` columns, and it
 *  should not have to fake the drawer's `touched`/`original` bookkeeping —
 *  which means nothing there — just to seed four fields. Keeping it a `Pick`
 *  (rather than a hand-written shape) is what makes a later rename in
 *  `ClientDraft` a compile error here instead of a silently dead seed. */
export function emptyShippingDraft(
  client: Pick<ClientDraft, 'name' | 'isCompany' | 'countryCode' | 'nationalNumber'> | null,
): ShippingDraft {
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
 *  `price` joins them for the same reason: the server 422s a shipment with
 *  no rate ("No rate is known for this service — supply shipping_price"), so
 *  a null price is exactly as incomplete as a missing name. Returns i18n
 *  keys so this stays testable without i18n. */
export function shippingDraftErrors(draft: ShippingDraft): ShippingDraftErrors {
  const phone = { countryCode: draft.countryCode, nationalNumber: draft.nationalNumber };
  return {
    island: draft.island.trim() ? null : 'aito.ruleShippingMissingIsland',
    firstName: draft.firstName.trim() ? null : 'aito.ruleShippingMissingRecipient',
    lastName: draft.lastName.trim() ? null : 'aito.ruleShippingMissingRecipient',
    // An empty number passes `validatePhone` (the client's phone is optional),
    // so emptiness is checked here — for a shipment it is not optional.
    phone: draft.nationalNumber.trim() && validatePhone(phone) === null ? null : 'aito.ruleShippingInvalidPhone',
    // null = no rate known and none typed yet (an error); 0 is a real, free
    // shipment and must stay valid — this is a null check, never falsiness.
    // A negative figure is checked separately: it is never null, so the
    // check above alone would wave it through.
    price: draft.price === null ? 'aito.shippingNoRate' : draft.price < 0 ? 'aito.shippingRateNegative' : null,
  };
}

/** What the form should currently show and gate Create on. Same masking rule
 *  as `visibleClientDraftErrors`. `price` is gated on the ISLAND's blurred
 *  flag rather than a flag of its own: the price only appears once an island
 *  is picked, and picking one is a single atomic action that already reveals
 *  (see `ShippingFields.selectIsland`) — a separate `blurred.price` would be
 *  a flag that is always redundant with `blurred.island`. */
export function visibleShippingDraftErrors(draft: ShippingDraft): ShippingDraftErrors {
  const errors = shippingDraftErrors(draft);
  return {
    island: draft.blurred.island ? errors.island : null,
    firstName: draft.blurred.firstName ? errors.firstName : null,
    lastName: draft.blurred.lastName ? errors.lastName : null,
    phone: draft.blurred.phone ? errors.phone : null,
    price: draft.blurred.island ? errors.price : null,
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

/** An island's display label: the Zoho-backed catalogue's own spelling when
 *  `services` has resolved it, and a readable degrade when it hasn't (Zoho
 *  unreachable, or the request simply hasn't landed yet).
 *
 *  The one place every surface that shows an island — the create drawer's
 *  rail/checklist, the panel header's pill, `ShippingCard`'s read view —
 *  computes that label, so the three can never show three different degrades
 *  for the same key at once (which is exactly what happened before this was
 *  extracted: the pill fell back to the raw key while the card fell back to
 *  a naive capitalisation of it).
 *
 *  The degrade splits on the hyphen six of the forty-five island keys carry
 *  (`bora-bora`, `puka-puka`, `nuku-hiva`, `hiva-oa`, `ua-pou`, `ua-huka`)
 *  and re-joins with a SPACE rather than reusing the raw separator —
 *  `island_label` in aito_shipping.py spells every one of those "Bora Bora",
 *  never "Bora-Bora". `titleCaseSegments` already does the per-segment
 *  capitalisation `ShippingFields` uses for a hand-typed name; reused here
 *  rather than a second capitaliser, on the space-joined key so its own
 *  separator-preserving split has nothing but spaces left to preserve. */
export function islandLabel(key: string, services: AitoShippingService[]): string {
  const catalogued = services.flatMap((service) => service.islands).find((island) => island.key === key)?.label;
  return catalogued ?? titleCaseSegments(key.replace(/-/g, ' '));
}
