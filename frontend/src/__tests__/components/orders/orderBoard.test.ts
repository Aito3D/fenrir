// The shop is in UTC-10: a date-only string must not slide to the day before.
process.env.TZ = 'Pacific/Tahiti';

import { describe, expect, it } from 'vitest';
import type { OrderBoardLine, OrderBoardResponse, OrderBoardRow } from '../../../api/client';
import {
  ageTone,
  byBrand,
  bySearch,
  byStatus,
  countByStatus,
  foldText,
  formatQty,
  isBoardReady,
  panelGroups,
  parseDay,
  pollMs,
  sortRows,
  totalValue,
} from '../../../components/orders/orderBoard';

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Thing', sku: 'SKU-1', state: 'ready', quantity: 1, shipped: 0, cancelled: 0,
  remaining: 1, invoiced: 0, packed_waiting: 0, stock_available: 1, covered: 1, shortfall: 0, covered_by_po: 0,
  po_numbers: [], ...o,
});

const row = (o: Partial<OrderBoardRow> = {}): OrderBoardRow => ({
  id: 'so1', number: 'SO-00001', customer: 'Atelier Moana', date: '2026-10-02', total: 100, currency: 'XPF',
  status: 'to_ship', age_days: 5, is_core: true, ready_ratio: 1, packed: 0,
  units: { total: 1, shipped: 0, ready: 1, backordered: 0, to_order: 0 }, packages: [], lines: [line()],
  zoho_url: null, ...o,
});

const board = (o: Partial<OrderBoardResponse> = {}, sync: Partial<OrderBoardResponse['sync']> = {}): OrderBoardResponse => ({
  rows: [], computed_at: '2026-11-05T19:42:00+00:00', stock_loaded_at: '2026-11-05T19:42:00+00:00',
  sync: { enabled: true, configured: true, running: false, pending: 0, last_error: null, last_error_at: null, last_success_at: null, ...sync },
  ...o,
});

describe('search', () => {
  const rows = [
    row({ id: 'a', number: 'SO-00412', customer: 'Lycée Polyvalent de Taravao' }),
    row({ id: 'b', number: 'SO-00418', customer: 'Fare Print', lines: [line({ name: 'eSUN PETG Blanc', sku: 'ES-PETG-WH' })] }),
  ];

  it('ignores case and accents', () => {
    expect(foldText('Lycée')).toBe('lycee');
    expect(bySearch(rows, 'LYCEE').map(r => r.id)).toEqual(['a']);
  });

  it('matches the order number, a line name and a line SKU', () => {
    expect(bySearch(rows, '00418').map(r => r.id)).toEqual(['b']);
    expect(bySearch(rows, 'petg blanc').map(r => r.id)).toEqual(['b']);
    expect(bySearch(rows, 'es-petg').map(r => r.id)).toEqual(['b']);
  });

  it('returns everything for an empty query', () => {
    expect(bySearch(rows, '  ')).toHaveLength(2);
  });

  it('survives rows with empty or missing text', () => {
    const odd = row({ customer: '', lines: [line({ sku: '', name: '' })] });
    // @ts-expect-error a null that slipped through from the server must not throw
    odd.customer = null;
    expect(bySearch([odd], 'x')).toEqual([]);
  });
});

describe('scopes', () => {
  const rows = [
    row({ id: 'core-ship', status: 'to_ship', is_core: true, customer: 'Alpha' }),
    row({ id: 'core-partial', status: 'partial', is_core: true, customer: 'Beta' }),
    row({ id: 'side-ship', status: 'to_ship', is_core: false, customer: 'Alpha Voiles' }),
  ];

  it('tiles follow the brand toggle only', () => {
    expect(countByStatus(byBrand(rows, true))).toEqual({ all: 2, to_ship: 1, partial: 1, incoming: 0, to_order: 0 });
    expect(countByStatus(byBrand(rows, false)).all).toBe(3);
  });

  it('chips follow the brand toggle and the search', () => {
    expect(countByStatus(bySearch(byBrand(rows, false), 'alpha'))).toMatchObject({ all: 2, to_ship: 2, partial: 0 });
  });

  it('the list follows all three', () => {
    expect(byStatus(bySearch(byBrand(rows, true), 'alpha'), 'to_ship').map(r => r.id)).toEqual(['core-ship']);
    expect(byStatus(rows, 'all')).toHaveLength(3);
  });

  it('adds up values, counting an unknown value as 0', () => {
    expect(totalValue([row({ total: 100 }), row({ total: null }), row({ total: 50 })])).toBe(150);
  });
});

describe('sortRows', () => {
  const rows = [
    row({ id: 'fred', customer: 'Fred', age_days: 3, total: null, ready_ratio: 0.5 }),
    row({ id: 'dan', customer: 'Dan', age_days: 40, total: 10, ready_ratio: 1 }),
    row({ id: 'emile', customer: 'Émile', age_days: 12, total: 900, ready_ratio: 0 }),
  ];
  const ids = (key: Parameters<typeof sortRows>[1], flipped = false) => sortRows(rows, key, flipped, 'fr').map(r => r.id);

  it('age: oldest first', () => expect(ids('age')).toEqual(['dan', 'emile', 'fred']));
  it('value: highest first, unknown as 0', () => expect(ids('value')).toEqual(['emile', 'dan', 'fred']));
  it('customer: A to Z, locale-aware', () => expect(ids('customer')).toEqual(['dan', 'emile', 'fred']));
  it('% ready: highest first', () => expect(ids('ready')).toEqual(['dan', 'fred', 'emile']));
  it('flipped reverses', () => expect(ids('age', true)).toEqual(['fred', 'emile', 'dan']));
  it('does not reorder its input', () => {
    sortRows(rows, 'age', false, 'fr');
    expect(rows[0].id).toBe('fred');
  });
});

describe('readiness and polling', () => {
  it('is ready only with rows, a computed board and loaded stock', () => {
    expect(isBoardReady(undefined)).toBe(false);
    expect(isBoardReady(board({ computed_at: null }))).toBe(false);
    expect(isBoardReady(board({ stock_loaded_at: null }))).toBe(false);
    expect(isBoardReady(board())).toBe(true);
  });

  it('polls fast while syncing, pending or never computed, slowly otherwise', () => {
    expect(pollMs(undefined)).toBe(4000);
    expect(pollMs(board({}, { running: true }))).toBe(4000);
    expect(pollMs(board({}, { pending: 3 }))).toBe(4000);
    expect(pollMs(board({ computed_at: null }))).toBe(4000);
    expect(pollMs(board())).toBe(60000);
  });

  it('does not poll fast for a board that cannot arrive', () => {
    expect(pollMs(board({ computed_at: null }, { enabled: false }))).toBe(60000);
    expect(pollMs(board({ computed_at: null }, { configured: false }))).toBe(60000);
  });
});

describe('small formatters', () => {
  it('age tone: neutral to 20, warning to 45, danger above', () => {
    expect([20, 21, 45, 46].map(ageTone)).toEqual(['neutral', 'warning', 'warning', 'danger']);
  });

  it('quantities keep a fraction and drop float noise', () => {
    expect(formatQty(2)).toBe('2');
    expect(formatQty(2.5)).toBe('2.5');
    expect(formatQty(0.1 + 0.2)).toBe('0.3');
  });

  it('a date-only string stays on its calendar day in UTC-10', () => {
    expect(new Date('2026-09-12').getDate()).toBe(11); // the trap, proving the zone is applied
    expect(parseDay('2026-09-12').getDate()).toBe(12);
    expect(parseDay('2026-09-12').getMonth()).toBe(8);
  });
});

describe('panelGroups', () => {
  it('splits a partly shipped, partly packed order into its groups', () => {
    const heiva = row({
      lines: [
        line({ id: 'ams', name: 'AMS Lite', state: 'backorder', quantity: 6, shipped: 2, remaining: 4, shortfall: 2 }),
        line({ id: 'petg', name: 'PETG', state: 'shipped', quantity: 4, shipped: 4, remaining: 0 }),
        line({ id: 'asa', name: 'ASA', state: 'ready', quantity: 2, remaining: 2, packed_waiting: 2 }),
        line({ id: 'ship', name: 'Livraison', state: 'service', item_id: null, stock_available: null }),
      ],
    });
    const groups = panelGroups(heiva);
    expect(groups.map(g => [g.id, g.units])).toEqual([['todo', 4], ['packed', 2], ['shipped', 6], ['other', null]]);
    expect(groups[0].lines.map(l => [l.line.id, l.qty, l.ofQty])).toEqual([['ams', 4, 6]]);
    expect(groups[1].lines.map(l => [l.line.id, l.qty, l.ofQty])).toEqual([['asa', 2, null]]);
    expect(groups[2].lines.map(l => [l.line.id, l.qty, l.ofQty])).toEqual([['ams', 2, 6], ['petg', 4, null]]);
    expect(groups[3].lines.map(l => l.line.id)).toEqual(['ship']);
  });

  it('gives only To prepare when nothing is packed or shipped', () => {
    expect(panelGroups(row()).map(g => g.id)).toEqual(['todo']);
  });

  it('keeps a half-packed line in both To prepare and Packed', () => {
    const groups = panelGroups(row({ lines: [line({ quantity: 5, remaining: 5, packed_waiting: 2 })] }));
    expect(groups.map(g => [g.id, g.lines[0].qty, g.lines[0].ofQty])).toEqual([['todo', 3, 5], ['packed', 2, 5]]);
  });
});
