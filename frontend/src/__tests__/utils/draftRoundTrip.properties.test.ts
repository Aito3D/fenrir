import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parsePhone, formatPhone, titleCaseSegments, formatDisplayName } from '../../utils/clientDraft';
import { COUNTRY_CODES } from '../../utils/countryCodes';
import { splitRecipientName } from '../../utils/shippingDraft';
import { matchesSearch } from '../../utils/aitoSearch';
import type { AitoProject } from '../../api/client';

const RUNS = { seed: 42, numRuns: 200 } as const;
const CODES = COUNTRY_CODES.map((c) => c.code);

/** The alphabet an operator actually types into a name field in this
 *  French-facing app: plain ASCII letters, the accented Latin letters that
 *  appear in French given/family names, and the separators
 *  `titleCaseSegments` treats specially (space, hyphen) plus an apostrophe
 *  (d'Artagnan-style names). Confirmed with `fc.sample` below to actually
 *  produce accented output, unlike the default `fc.string()` (ASCII-only —
 *  see the report for why that made the old property unable to fail). */
const FRENCH_NAME_ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'é', 'è', 'ê', 'ë', 'à', 'â', 'ù', 'û', 'ü', 'ï', 'î', 'ô', 'ç', 'œ',
  'É', 'È', 'Ê', 'À', 'Â', 'Ç', 'Ù', 'Œ',
  ' ', '-', "'",
];
const frenchNameText = (maxLength: number) => fc.stringOf(fc.constantFrom(...FRENCH_NAME_ALPHABET), { maxLength });

/** Mirrors `titleCaseSegments`'s split/rejoin shape exactly (same regex, same
 *  odd/even segment roles, same join), but with the LOCALE-LESS case methods
 *  a regression could swap in for the real `'fr'`-aware ones. Comparing full
 *  output CONTENT against this — not just a stripped character count — is
 *  what catches a structural regression (wrong join separator, case applied
 *  to the wrong half of a segment, a separator capitalized instead of
 *  content) that a length-only assertion cannot see.
 *
 *  This reference is deliberately locale-less, so by construction it cannot
 *  distinguish a dropped `'fr'` argument from the real code — see the task 6
 *  report for the evidence (a full-codepoint scan) that no property can:
 *  `toLocaleUpperCase('fr')`/`toLocaleLowerCase('fr')` are byte-identical to
 *  their locale-less counterparts for every Unicode code point in this
 *  runtime, because French carries no entries in Unicode's
 *  SpecialCasing.txt (only lt/tr/az do). */
function referenceTitleCase(value: string): string {
  return value
    .trim()
    .split(/([ -]+)/)
    .map((part, index) => (index % 2 ? part : part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase()))
    .join('');
}

/** `matchesSearch` reads exactly three fields off a full `AitoProject`
 *  (`description`, `client_name`, `quote_number`) via its internal
 *  `haystack()`, but the type is not a partial — a property that hands it a
 *  card needs the whole shape. Every other field is pinned to a plausible,
 *  type-correct default; only the three fields the function reads vary. */
function makeCard(overrides: Partial<Pick<AitoProject, 'description' | 'client_name' | 'quote_number'>>): AitoProject {
  return {
    id: 1,
    description: '',
    column: 'devis',
    position: 0,
    status: 'active',
    client_id: null,
    client_name: null,
    client_phone: null,
    client_email: null,
    client_is_company: null,
    client_social_network: null,
    client_social_handle: null,
    quote_id: null,
    quote_number: null,
    quote_date: null,
    quote_total: null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: null,
    quote_accepted_at: null,
    quote_sent_at: null,
    invoice_status: null,
    invoice_balance: null,
    invoice_due_date: null,
    invoice_checked_at: null,
    quote_sync_state: 'idle',
    quote_invoiced: false,
    flag: null,
    client_contacted_at: null,
    due_date: null,
    quote_sync_error: null,
    quote_status_block: null,
    quote_status_remote: null,
    created_by: null,
    task_count: 0,
    tasks_total: 0,
    task_services: [],
    steps_total: 0,
    steps_done: 0,
    print_minutes_pending: 0,
    task_steps: [],
    task_pending: [],
    move_lock: null,
    shipping_island: null,
    shipping_service: null,
    shipping_first_name: null,
    shipping_last_name: null,
    shipping_phone: null,
    shipping_price: null,
    shipping_lta: null,
    shipping_service_name: null,
    tracking_url: null,
    tracking_configured: false,
    version: 1,
    created_at: '2026-07-27T00:00:00',
    updated_at: '2026-07-27T00:00:00',
    ...overrides,
  };
}

describe('phone parse/format round-trip', () => {
  // A stored phone is written as `+CC-national`. Splitting it and rebuilding
  // it must give back what was stored, or an operator's number silently
  // changes when a form is reopened.
  it('rebuilds every code + national pair it was given', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...CODES),
        fc.stringMatching(/^[0-9]{4,14}$/),
        (code, national) => {
          const stored = `${code}-${national}`;
          const parsed = parsePhone(stored);
          expect(formatPhone(parsed)).toBe(stored);
        },
      ),
      RUNS,
    );
  });

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const parsed = parsePhone(raw);
        expect(typeof parsed.countryCode).toBe('string');
        expect(typeof parsed.nationalNumber).toBe('string');
      }),
      RUNS,
    );
  });
});

describe('name helpers are total', () => {
  it('titleCaseSegments matches a locale-less reference implementation, content and all', () => {
    fc.assert(
      fc.property(frenchNameText(40), (raw) => {
        expect(titleCaseSegments(raw)).toBe(referenceTitleCase(raw));
      }),
      RUNS,
    );
  });

  it('splitRecipientName never drops the last word', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const { firstName, lastName } = splitRecipientName(raw);
        const words = raw.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) {
          expect(lastName).toBe('');
        } else {
          expect(lastName).toBe(words[words.length - 1]);
        }
        expect(typeof firstName).toBe('string');
      }),
      RUNS,
    );
  });

  // formatDisplayName is titleCaseSegments(firstName) + ' ' +
  // lastName.trim().toLocaleUpperCase('fr'), trimmed — the house convention
  // for a person contact ('Jean-Pierre DUPONT'). Pinning that the rendered
  // string always ends with the trimmed, upper-cased last name (when there
  // is one) catches a wrong field order or a missed uppercase step, without
  // re-deriving the whole function.
  it('formatDisplayName always ends with the trimmed, upper-cased last name', () => {
    fc.assert(
      fc.property(frenchNameText(20), frenchNameText(20), (firstName, lastName) => {
        const out = formatDisplayName(firstName, lastName);
        expect(typeof out).toBe('string');
        const trimmedLast = lastName.trim();
        if (trimmedLast) {
          expect(out.endsWith(trimmedLast.toLocaleUpperCase('fr'))).toBe(true);
        } else {
          expect(out).toBe(titleCaseSegments(firstName).trim());
        }
      }),
      RUNS,
    );
  });
});

// Plain/accented pairs of real French words, so the fold property below
// exercises fold()'s actual job (NFD-normalize and strip combining marks)
// rather than relying on fast-check to stumble onto an accented character.
const DIACRITIC_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['camera', 'caméra'],
  ['deja', 'déjà'],
  ['creme', 'crème'],
  ['eleve', 'élève'],
  ['cafe', 'café'],
  ['noel', 'noël'],
  ['gerant', 'gérant'],
  ['decoration', 'décoration'],
];

describe('board search is total', () => {
  // Weak by construction — every operation matchesSearch performs (normalize,
  // replace, toLowerCase, split, includes) is total over any string, so no
  // implementation could make this fail. Kept as a cheap totality/shape
  // check, not as one of the load-bearing properties.
  it('never throws, whatever the query or the card', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (query, name) => {
        const card = makeCard({ client_name: name, description: name });
        expect(typeof matchesSearch(card, query)).toBe('boolean');
      }),
      RUNS,
    );
  });

  // Non-load-bearing sanity check — matchesSearch returns true on an empty
  // query from its very first line (terms.length === 0), before it ever
  // reads the card, so this alone proves nothing about the card. Kept
  // because it is still true and cheap, not counted as a real property.
  it('an empty query matches everything', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        const card = makeCard({ client_name: name, description: name });
        expect(matchesSearch(card, '')).toBe(true);
      }),
      RUNS,
    );
  });

  // The real property behind "an accented query finds a plain card, and vice
  // versa": fold() is applied to BOTH the query and the haystack (the source
  // comment's own justification — folding only one side would still fail the
  // user who types the accent). Every combination of plain/accented query
  // against plain/accented card text must match.
  it('folds diacritics on both the query and the card text', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DIACRITIC_PAIRS),
        fc.boolean(),
        fc.boolean(),
        ([plain, accented], queryAccented, cardAccented) => {
          const query = queryAccented ? accented : plain;
          const cardText = cardAccented ? accented : plain;
          const card = makeCard({ description: cardText });
          expect(matchesSearch(card, query)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  // The AND behaviour documented at aitoSearch.ts:23-27 ("dupont gopro" finds
  // a card whose client supplies one word and description the other): a term
  // that genuinely is not present anywhere in the card must exclude it, even
  // when another term in the same query does match.
  it('ANDs whitespace-separated terms — one absent term excludes the card', () => {
    const ABSENT_SENTINEL = 'unmatchedsentinelxyz';
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{3,10}$/), (present) => {
        const card = makeCard({ description: present });
        expect(matchesSearch(card, present)).toBe(true);
        expect(matchesSearch(card, `${present} ${ABSENT_SENTINEL}`)).toBe(false);
      }),
      RUNS,
    );
  });
});
