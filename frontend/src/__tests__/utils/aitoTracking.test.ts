import { describe, it, expect } from 'vitest';
import { FR, frLongDate, frUpdated, statusCopy, trackStages } from '../../utils/aitoTracking';
import type { AitoTracking } from '../../api/client';

const base: AitoTracking = {
  column: 'print', tasks: [], due_date: null, shipping: null, done_at: null, invoice: null, reference: null, updated_at: '2026-09-06T19:42:00',
};

describe('aitoTracking', () => {
  it('lists the seven stages in board order, the last one named by how the order ends', () => {
    expect(trackStages(false).map((s) => s.id)).toEqual(['devis', 'waiting', 'scan', 'model', 'print', 'finish', 'done']);
    expect(trackStages(false).map((s) => s.label)).toEqual(['Devis', 'Accord', 'Scan', 'Modélisation', 'Fabrication', 'Prête', 'Récupérée']);
    expect(trackStages(true)[6].label).toBe('Expédiée');
  });

  it('formats a long French date from an ISO day or timestamp', () => {
    expect(frLongDate('2026-09-20')).toBe('20 septembre 2026');
    expect(frLongDate('2026-09-01T18:20:00')).toBe('1 septembre 2026');
  });

  it('phrases the update time relative to today, in local time', () => {
    // 19:42 UTC is 09:42 in the UTC-10 sandbox; pin `now` so the test is day-stable.
    const now = new Date('2026-09-06T21:00:00Z');
    expect(frUpdated('2026-09-06T19:42:00', now)).toMatch(/^aujourd'hui à \d{2}:\d{2}$/);
    expect(frUpdated('2026-09-05T19:42:00', now)).toMatch(/^hier à \d{2}:\d{2}$/);
    expect(frUpdated('2026-09-03T21:05:00', now)).toMatch(/^le 3 septembre à \d{2}:\d{2}$/);
  });

  it('picks a short title and a human sub-line per state', () => {
    expect(statusCopy({ ...base, column: 'devis' })).toEqual(FR.status.devis);
    expect(statusCopy({ ...base, column: 'waiting' })).toEqual(FR.status.waiting);
    for (const column of ['scan', 'model', 'print'] as const) expect(statusCopy({ ...base, column })).toEqual(FR.status.working);
    expect(FR.status.working.title).toBe('En fabrication');
    expect(statusCopy({ ...base, column: 'finish' })).toEqual(FR.status.finish);
    expect(statusCopy({ ...base, column: 'done', shipping: { island: 'Rangiroa', service: 'Livraison Avion Tuamotu' } })).toEqual({
      title: 'Expédiée',
      sub: 'Vers Rangiroa par Livraison Avion Tuamotu.',
    });
    expect(statusCopy({ ...base, column: 'done', done_at: '2026-09-01T18:20:00' })).toEqual({
      title: 'Récupérée',
      sub: 'Le 1 septembre 2026. Merci pour votre confiance !',
    });
    expect(statusCopy({ ...base, column: 'done' })).toEqual(FR.status.doneBare);
  });
});
