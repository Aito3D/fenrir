import { describe, it, expect } from 'vitest';
import { canMarkDone } from '../../components/aito/canMarkDone';
import type { AitoProject } from '../../api/client';

// The one gate both surfaces that offer Finish -> Done read (the board card
// and the panel footer), so they can never disagree about when it is open.
// Mirrors the server's own refusals in `move_project`: column, rules lock,
// client contact, and — for a quoted project — an invoice in Books.
const finished = (over: Partial<AitoProject> = {}): AitoProject =>
  ({
    column: 'finish',
    move_lock: null,
    client_contacted_at: '2026-08-20T09:00:00Z',
    quote_id: 'EST-1',
    quote_invoiced: true,
    ...over,
  }) as unknown as AitoProject;

describe('canMarkDone', () => {
  it('opens on a contacted, invoiced, released card in Finish', () => {
    expect(canMarkDone(finished())).toBe(true);
  });

  it('stays shut on a quoted project whose quote is not invoiced yet', () => {
    expect(canMarkDone(finished({ quote_invoiced: false }))).toBe(false);
  });

  it('opens for a card with no quote at all — there is nothing to invoice', () => {
    expect(canMarkDone(finished({ quote_id: null, quote_invoiced: false }))).toBe(true);
  });

  it('stays shut while the client has not been told', () => {
    expect(canMarkDone(finished({ client_contacted_at: null }))).toBe(false);
  });

  it('stays shut while the rules hold the card', () => {
    expect(canMarkDone(finished({ move_lock: 'declined' }))).toBe(false);
  });

  it('stays shut outside Finish', () => {
    for (const column of ['devis', 'waiting', 'scan', 'model', 'print', 'done'] as const) {
      expect(canMarkDone(finished({ column }))).toBe(false);
    }
  });
});
