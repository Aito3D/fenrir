import { describe, it, expect } from 'vitest';
import { matchesSearch, searchProjects } from '../../utils/aitoSearch';
import type { AitoProject } from '../../api/client';

const card = (over: Partial<AitoProject> = {}): AitoProject => ({
  id: 1,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: null,
  client_name: 'ACME SARL',
  client_phone: null,
  client_email: null,
  client_is_company: null,
  client_social_network: null,
  client_social_handle: null,
  client_contact_person_id: null,
  client_contact_name: null,
  quote_id: null,
  quote_number: 'QT-0041',
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
  task_pending: [],
  steps_total: 0,
  steps_done: 0,
  print_minutes_pending: 0,
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_lta: null,
  shipping_service_name: null,
  tracking_configured: false,
  search_text: '',
  document_numbers: [],
  quote_expiry_date: null,
  retainer_paid_total: null,
  customer_credit_total: null,
  payment_link: null,
  version: 1,
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-01T10:00:00Z',
  ...over,
});

describe('matchesSearch', () => {
  it('matches everything on an empty or whitespace-only query', () => {
    expect(matchesSearch(card(), '')).toBe(true);
    expect(matchesSearch(card(), '   ')).toBe(true);
  });

  it('matches the description', () => {
    expect(matchesSearch(card(), 'support')).toBe(true);
  });

  it('matches the client name', () => {
    expect(matchesSearch(card(), 'acme')).toBe(true);
  });

  it('matches the quote number', () => {
    expect(matchesSearch(card(), 'qt-0041')).toBe(true);
  });

  it('ignores case on both sides', () => {
    expect(matchesSearch(card({ description: 'GoPro' }), 'gopro')).toBe(true);
    expect(matchesSearch(card({ description: 'gopro' }), 'GOPRO')).toBe(true);
  });

  it('folds diacritics so an unaccented query finds accented text', () => {
    expect(matchesSearch(card({ description: 'Support de caméra' }), 'camera')).toBe(true);
    expect(matchesSearch(card({ description: 'Pièce détachée' }), 'piece detachee')).toBe(true);
  });

  it('folds diacritics in the query too', () => {
    expect(matchesSearch(card({ description: 'Piece detachee' }), 'pièce')).toBe(true);
  });

  it('ANDs terms across different fields', () => {
    const p = card({ client_name: 'Dupont', description: 'Support GoPro' });
    expect(matchesSearch(p, 'dupont gopro')).toBe(true);
    expect(matchesSearch(p, 'dupont martin')).toBe(false);
  });

  it('collapses runs of whitespace between terms', () => {
    expect(matchesSearch(card({ description: 'Support GoPro' }), '  support   gopro  ')).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(matchesSearch(card(), 'zzzz')).toBe(false);
  });

  it('survives a null client name and quote number', () => {
    const p = card({ client_name: null, quote_number: null });
    expect(matchesSearch(p, 'support')).toBe(true);
    expect(matchesSearch(p, 'acme')).toBe(false);
  });
});

describe('searchProjects — fields', () => {
  const top = (projects: AitoProject[], q: string) => searchProjects(projects, q)[0];

  it('finds a phone typed with spaces, dots or +689', () => {
    const p = card({ client_phone: '+689 87 12 34 56' });
    for (const q of ['87123456', '87 12 34 56', '+689 87.12.34.56', '3456']) {
      const hit = top([p], q);
      expect(hit?.field, q).toBe('clientPhone');
    }
    expect(top([p], '87 12 34 56')!.excerpt.match).toBe('+689 87 12 34 56');
  });

  it('does not phone-match under 4 digits', () => {
    expect(searchProjects([card({ client_phone: '87123456', quote_number: null })], '12')).toEqual([]);
  });

  it('finds the shipping recipient phone and name', () => {
    const p = card({ shipping_phone: '40 50 60 70', shipping_first_name: 'Teva', shipping_last_name: 'Tama' });
    expect(top([p], '40506070')!.field).toBe('shippingPhone');
    expect(top([p], 'tama')!.field).toBe('recipient');
  });

  it('finds an email by any part', () => {
    const p = card({ client_email: 'jean.dupont@gmail.com' });
    expect(top([p], '@gmail')!.field).toBe('email');
    expect(top([p], 'dupont@')!.field).toBe('email');
  });

  it('finds quote, invoice and LTA numbers without prefix or zeros', () => {
    const p = card({ quote_number: 'DEV-00123', document_numbers: ['INV-000456'], shipping_lta: '914-1234 5675' });
    expect(top([p], '123')!.field).toBe('quote');
    expect(top([p], 'dev123')!.field).toBe('quote');
    expect(top([p], '456')!.field).toBe('document');
    expect(top([p], 'inv:456')!.field).toBe('document');
    expect(top([p], '12345675')!.field).toBe('lta');
  });

  it('finds the card id only with #', () => {
    const p = card({ id: 41, quote_number: null, description: 'x', client_name: null });
    expect(top([p], '#41')!.field).toBe('cardId');
    expect(searchProjects([p], '41')).toEqual([]);
  });

  it('finds contact person, social handle and salesperson', () => {
    const p = card({ client_contact_name: 'Hina Lee', client_social_handle: '@hinalee', quote_salesperson: 'Marc' });
    expect(top([p], 'hina')!.field).toBe('contact');
    expect(top([p], 'marc')!.field).toBe('salesperson');
  });

  it('finds task notes', () => {
    const hit = top([card({ search_text: 'Fixation casque\nPETG bleu' })], 'casque');
    expect(hit!.field).toBe('task');
    expect(hit!.excerpt.match).toBe('casque');
  });

  it('accepts one typo in a name of 4+ letters, not in short words', () => {
    expect(top([card({ client_name: 'Dupont' })], 'dupnt')!.field).toBe('client');
    expect(searchProjects([card({ client_name: 'Bob', description: 'x', quote_number: null })], 'bbo')).toEqual([]);
  });

  it('restricts a prefixed term to its field kind', () => {
    const p = card({ client_phone: '87123456', quote_number: 'DEV-87123456' });
    expect(top([p], 'tel:87123456')!.field).toBe('clientPhone');
    expect(top([p], '#87123456')!.field).toBe('quote');
  });
});

describe('searchProjects — ranking', () => {
  it('ranks exact identifier > name > description > task > typo', () => {
    const exact = card({ id: 1, quote_number: 'DEV-777', description: 'a', client_name: null });
    const name = card({ id: 2, client_name: 'Kaimana', description: 'b', quote_number: null });
    const desc = card({ id: 3, description: 'Kaimana trophy', client_name: null, quote_number: null });
    const task = card({ id: 4, description: 'c', client_name: null, quote_number: null, search_text: 'kaimana logo' });
    const typo = card({ id: 5, client_name: 'Kaimama', description: 'd', quote_number: null });
    expect(searchProjects([typo, task, desc, name], 'kaimana').map((h) => h.project.id)).toEqual([2, 3, 4, 5]);
    expect(searchProjects([name, exact], '777')[0].project.id).toBe(1);
  });

  it('breaks ties board > done > trash, then most recent', () => {
    const board = card({ id: 1, client_name: 'Tane', updated_at: '2026-01-01T00:00:00Z' });
    const done = card({ id: 2, client_name: 'Tane', column: 'done', updated_at: '2026-09-01T00:00:00Z' });
    const trash = card({ id: 3, client_name: 'Tane', status: 'deleted', updated_at: '2026-09-02T00:00:00Z' });
    const newer = card({ id: 4, client_name: 'Tane', updated_at: '2026-02-01T00:00:00Z' });
    const hits = searchProjects([trash, done, board, newer], 'tane');
    expect(hits.map((h) => h.project.id)).toEqual([4, 1, 2, 3]);
    expect(hits.map((h) => h.location)).toEqual(['board', 'board', 'done', 'trash']);
  });

  it('ANDs terms across fields and reports the strongest one', () => {
    const p = card({ client_name: 'Dupont', client_phone: '87123456', description: 'Support GoPro' });
    const hit = searchProjects([p], 'gopro 87123456')[0];
    expect(hit.field).toBe('clientPhone');
    expect(searchProjects([p], 'gopro zzzz')).toEqual([]);
  });

  it('slices excerpts from the original accented text', () => {
    const hit = searchProjects([card({ description: 'Grand support de caméra pour la voiture de course' })], 'camera')[0];
    expect(hit.excerpt.match).toBe('caméra');
    expect(hit.excerpt.before.endsWith('support de ')).toBe(true);
  });

  it('returns nothing for an empty query', () => {
    expect(searchProjects([card()], '   ')).toEqual([]);
  });
});

describe('searchProjects — number grouping and phone shape', () => {
  const quoteCard = card({ id: 1, quote_number: 'DEV-2638', description: 'Plaque 1200 mm', client_name: null });

  it('keeps unrelated 4-digit numbers as separate terms', () => {
    expect(searchProjects([quoteCard], 'dev 2638 1200')).toHaveLength(1);
    expect(searchProjects([quoteCard], '2638 1200')).toHaveLength(1);
  });

  it('still merges phone groups', () => {
    const p = card({ client_phone: '87 12 34 56', quote_number: null });
    for (const q of ['87 12 34 56', '+689 87 12 34 56', '8712 3456']) {
      expect(searchProjects([p], q)[0]?.field, q).toBe('clientPhone');
    }
  });

  it('does not phone-match identifiers or dates', () => {
    const phoneCard = card({ id: 2, client_phone: '87 26 38 11', quote_number: null, client_name: null });
    expect(searchProjects([quoteCard, phoneCard], 'dev2638').map((h) => h.project.id)).toEqual([1]);
    expect(searchProjects([phoneCard], 'DEV-2638')).toEqual([]);
    expect(searchProjects([phoneCard], 'tel:dev2638')).toEqual([]);
  });
});
