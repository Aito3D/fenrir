import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../i18n';
import { etaCopy, longDate, statusCopy, trackStages, trackingDefaultLanguage, trackingStage, updatedAt } from '../../utils/aitoTracking';
import type { AitoTracking } from '../../api/client';
import type { TFunction } from 'i18next';

const base: AitoTracking = {
  column: 'print', tasks: [], due_date: null, shipping: null, done_at: null, invoice: null, payment: null, reference: null, updated_at: '2026-09-06T19:42:00', accepted: false,
};

let fr: TFunction;
let en: TFunction;
beforeAll(async () => {
  await i18n.loadLanguages(['fr', 'de']);
  fr = i18n.getFixedT('fr');
  en = i18n.getFixedT('en');
});

describe('aitoTracking', () => {
  it('lists the seven stages in board order, the last one named by how the order ends', () => {
    expect(trackStages(false, fr).map((s) => s.id)).toEqual(['devis', 'waiting', 'scan', 'model', 'print', 'finish', 'done']);
    expect(trackStages(false, fr).map((s) => s.label)).toEqual(['Devis', 'Accord', 'Scan 3D', 'Modélisation', 'Fabrication', 'Prête', 'Récupérée']);
    expect(trackStages(true, fr)[6].label).toBe('Expédiée');
    expect(trackStages(true, en)[6].label).toBe('Shipped');
  });

  it('formats a long date from an ISO day or timestamp, in the page language', () => {
    expect(longDate('2026-09-20', 'fr')).toBe('20 septembre 2026');
    expect(longDate('2026-09-01T18:20:00', 'fr')).toBe('1 septembre 2026');
    expect(longDate('2026-09-20', 'en')).toBe('September 20, 2026'); // Intl's bare `en` is US English
    expect(longDate('2026-09-20', 'de')).toBe('20. September 2026');
  });

  it('phrases the update time relative to today, in local time and the page language', () => {
    // 19:42 UTC is 09:42 in the UTC-10 sandbox; pin `now` so the test is day-stable.
    const now = new Date('2026-09-06T21:00:00Z');
    expect(updatedAt('2026-09-06T19:42:00', fr, 'fr', now)).toMatch(/^aujourd'hui à \d{2}:\d{2}$/);
    expect(updatedAt('2026-09-05T19:42:00', fr, 'fr', now)).toMatch(/^hier à \d{2}:\d{2}$/);
    expect(updatedAt('2026-09-03T21:05:00', fr, 'fr', now)).toMatch(/^le 3 septembre à \d{2}:\d{2}$/);
    expect(updatedAt('2026-09-03T21:05:00', en, 'en', now)).toMatch(/^on September 3 at \d{2}:\d{2} (AM|PM)$/);
  });

  it('picks a short title and a human sub-line per state', () => {
    expect(statusCopy({ ...base, column: 'devis' }, fr, 'fr')).toEqual({ title: 'Devis en préparation', sub: "Vous le recevrez par e-mail dès qu'il est prêt." });
    expect(statusCopy({ ...base, column: 'waiting' }, fr, 'fr').title).toBe('En attente de votre accord');
    for (const column of ['scan', 'model', 'print'] as const) expect(statusCopy({ ...base, column }, fr, 'fr').title).toBe('En fabrication');
    expect(statusCopy({ ...base, column: 'finish' }, fr, 'fr').title).toBe('Votre commande est prête');
    expect(statusCopy({ ...base, column: 'done', shipping: { island: 'Rangiroa', service: 'Livraison Avion Tuamotu', lta: '123-4567 8901' } }, en, 'en')).toEqual({
      title: 'Shipped',
      sub: 'To Rangiroa by Livraison Avion Tuamotu. Waybill no. 123-4567 8901.',
    });
    expect(statusCopy({ ...base, column: 'done', done_at: '2026-09-01T18:20:00' }, fr, 'fr')).toEqual({
      title: 'Récupérée',
      sub: 'Le 1 septembre 2026. Merci pour votre confiance !',
    });
    expect(statusCopy({ ...base, column: 'done' }, fr, 'fr')).toEqual({ title: 'Terminée', sub: 'Merci pour votre confiance !' });
  });

  // A shipped order is "shipped" when the waybill exists, not when the card
  // is dragged to Done: the LTA is what the client hands over at the freight
  // counter, and typing it is the moment the parcel has actually left.
  describe('shipping orders', () => {
    const toShip = { island: 'Rangiroa', service: 'Livraison Avion Tuamotu', lta: null };
    const shipped = { ...toShip, lta: '123-4567 8901' };
    const prepared = {
      title: 'Votre commande va être expédiée',
      sub: "Vers Rangiroa par Livraison Avion Tuamotu. Le n° LTA s'affichera ici dès le dépôt.",
    };

    it('a ready order with a shipment says it will be shipped, never "collect it from the shop"', () => {
      expect(statusCopy({ ...base, column: 'finish', shipping: toShip }, fr, 'fr')).toEqual(prepared);
      expect(statusCopy({ ...base, column: 'finish', shipping: toShip }, en, 'en')).toEqual({
        title: 'Your order will be shipped',
        sub: 'To Rangiroa by Livraison Avion Tuamotu. The waybill number will appear here once it is dropped off.',
      });
    });

    it('Done without a waybill is still "will be shipped", not "shipped"', () => {
      expect(statusCopy({ ...base, column: 'done', shipping: toShip }, fr, 'fr')).toEqual(prepared);
    });

    it('the waybill flips a ready order to shipped before the card moves to Done', () => {
      expect(statusCopy({ ...base, column: 'finish', shipping: shipped }, fr, 'fr')).toEqual({
        title: 'Expédiée',
        sub: 'Vers Rangiroa par Livraison Avion Tuamotu. N° LTA 123-4567 8901.',
      });
    });

    it('a waybill typed while the parts are still being made changes nothing', () => {
      expect(statusCopy({ ...base, column: 'print', shipping: shipped }, fr, 'fr').title).toBe('En fabrication');
    });

    it('trackingStage: the rail node is the LTA, not the column, once the order is ready', () => {
      expect(trackingStage({ ...base, column: 'finish', shipping: toShip })).toBe('finish');
      expect(trackingStage({ ...base, column: 'done', shipping: toShip })).toBe('finish');
      expect(trackingStage({ ...base, column: 'finish', shipping: shipped })).toBe('done');
      expect(trackingStage({ ...base, column: 'done', shipping: shipped })).toBe('done');
      expect(trackingStage({ ...base, column: 'print', shipping: shipped })).toBe('print');
      // No shipment: the column is the stage, as before.
      expect(trackingStage({ ...base, column: 'finish' })).toBe('finish');
      expect(trackingStage({ ...base, column: 'done' })).toBe('done');
    });
  });

  it('devis keeps the plain "by e-mail" line even if a payment link slipped through', () => {
    // The backend never ships a pending link for a draft (2026-09-23), so the
    // state card has no pay-to-validate variant any more — a stale payload
    // must not resurrect one.
    const link = { state: 'unpaid' as const, url: 'https://osb/pay/1', deposit: false };
    expect(statusCopy({ ...base, column: 'devis', payment: link }, fr, 'fr')).toEqual({
      title: 'Devis en préparation',
      sub: "Vous le recevrez par e-mail dès qu'il est prêt.",
    });
    expect(statusCopy({ ...base, column: 'devis', payment: link, accepted: true }, fr, 'fr').sub).toBe("Vous le recevrez par e-mail dès qu'il est prêt.");
  });

  it('waiting reads "Devis validé" once the quote is accepted', () => {
    expect(statusCopy({ ...base, column: 'waiting', accepted: true }, fr, 'fr')).toEqual({ title: 'Devis validé', sub: 'Nous planifions la fabrication.' });
    expect(statusCopy({ ...base, column: 'waiting', accepted: false }, fr, 'fr').title).toBe('En attente de votre accord');
  });

  describe('etaCopy', () => {
    const today = new Date('2026-09-10T20:00:00Z');
    const at = (column: AitoTracking['column'], due_date: string | null): AitoTracking => ({ ...base, column, due_date });
    it('shows the date while it is not passed', () => {
      expect(etaCopy(at('print', '2026-09-20'), fr, 'fr', today)).toEqual({ kind: 'date', text: '20 septembre 2026' });
    });
    it('replaces a passed date with the updating line before Finish', () => {
      expect(etaCopy(at('print', '2026-09-01'), fr, 'fr', today)).toEqual({ kind: 'updating', text: 'Estimation en cours de mise à jour' });
      expect(etaCopy(at('finish', '2026-09-01'), fr, 'fr', today).kind).toBe('none');
    });
    it('promises a date only while in production, otherwise nothing', () => {
      expect(etaCopy(at('scan', null), fr, 'fr', today)).toEqual({ kind: 'soon', text: 'Nous vous communiquerons une date dès que possible.' });
      expect(etaCopy(at('devis', null), fr, 'fr', today).kind).toBe('none');
      expect(etaCopy(at('done', null), fr, 'fr', today).kind).toBe('none');
    });
    it('omits the date entirely once the order is ready or over, whatever the date', () => {
      expect(etaCopy(at('finish', '2099-01-01'), fr, 'fr', today).kind).toBe('none');
    });
  });

  describe('trackingDefaultLanguage', () => {
    const supported = ['en', 'de', 'fr', 'pt-BR'];
    it('keeps a remembered choice', () => {
      expect(trackingDefaultLanguage('de', ['fr-PF'], supported)).toBeNull();
    });
    it('keeps a browser language the app ships, on the full tag or its base', () => {
      expect(trackingDefaultLanguage(null, ['en-US', 'en'], supported)).toBeNull();
      expect(trackingDefaultLanguage(null, ['de-CH'], supported)).toBeNull();
      expect(trackingDefaultLanguage(null, ['pt-BR'], supported)).toBeNull();
    });
    it('falls back to French, not English, when nothing matches', () => {
      expect(trackingDefaultLanguage(null, ['ty', 'pt-PT'], supported)).toBe('fr');
      expect(trackingDefaultLanguage(null, [], supported)).toBe('fr');
      expect(trackingDefaultLanguage('xx', [], supported)).toBe('fr');
    });
  });
});
