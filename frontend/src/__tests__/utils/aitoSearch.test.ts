import { describe, it, expect } from 'vitest';
import { matchesSearch } from '../../utils/aitoSearch';
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
  quote_id: null,
  quote_number: 'QT-0041',
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  urgent: false,
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
  task_steps: [],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_service_name: null,
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
