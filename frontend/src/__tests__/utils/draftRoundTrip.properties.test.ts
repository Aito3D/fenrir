import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parsePhone, formatPhone, titleCaseSegments } from '../../utils/clientDraft';
import { COUNTRY_CODES } from '../../utils/countryCodes';
import { splitRecipientName } from '../../utils/shippingDraft';
import { matchesSearch } from '../../utils/aitoSearch';
import type { AitoProject } from '../../api/client';

const RUNS = { seed: 42, numRuns: 200 } as const;
const CODES = COUNTRY_CODES.map((c) => c.code);

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
  it('titleCaseSegments preserves the letters it was given', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const out = titleCaseSegments(raw);
        expect(out.replace(/\s/g, '').toLocaleLowerCase('fr').length).toBe(
          raw.trim().replace(/\s/g, '').toLocaleLowerCase('fr').length,
        );
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
});

describe('board search is total', () => {
  it('never throws, whatever the query or the card', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (query, name) => {
        const card = makeCard({ client_name: name, description: name });
        expect(typeof matchesSearch(card, query)).toBe('boolean');
      }),
      RUNS,
    );
  });

  it('an empty query matches everything', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        const card = makeCard({ client_name: name, description: name });
        expect(matchesSearch(card, '')).toBe(true);
      }),
      RUNS,
    );
  });
});
