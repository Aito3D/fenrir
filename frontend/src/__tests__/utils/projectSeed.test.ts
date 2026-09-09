import { describe, it, expect } from 'vitest';
import { isBlankPersistedDraft, seedFromProject } from '../../utils/projectSeed';
import { emptyTaskDraft, taskDraftFromAitoTask } from '../../utils/taskDraft';
import { defaultClientDraft } from '../../utils/clientDraft';
import type { AitoProject, AitoShippingService, AitoTask } from '../../api/client';

const project = {
  id: 12,
  description: 'Support de caméra, PLA noir',
  column: 'done',
  client_id: 'z1',
  client_name: 'Jean-Pierre DUPONT',
  client_phone: '+689-87123456',
  client_email: 'jp@example.pf',
  client_is_company: false,
  client_social_network: 'instagram',
  client_social_handle: 'jp_dupont',
  quote_id: 'EST-9',
  quote_number: 'EST-000009',
  quote_status: 'accepted',
  flag: 'urgent',
  due_date: '2026-09-20',
  client_contacted_at: '2026-09-01T10:00:00',
  tracking_url: 'https://x/t/abc',
  shipping_island: 'rangiroa',
  shipping_service: 'tuamotu',
  shipping_first_name: 'Jean-Pierre',
  shipping_last_name: 'DUPONT',
  shipping_phone: '+689-89645864',
  shipping_price: 2500,
  shipping_lta: '123-4567',
} as unknown as AitoProject;

const task = {
  id: 41,
  project_id: 12,
  position: 0,
  title: 'Support GoPro',
  scan_cost: 1000,
  scan_done: true,
  scan_quantity: 1,
  modelisation_cost: null,
  modelisation_done: false,
  usinage_cost: null,
  usinage_done: false,
  impression_printer_id: 3,
  impression_filament_id: 7,
  impression_weight_g: 42,
  impression_time_min: 180,
  impression_quantity: 2,
  impression_color: 'noir',
  impression_cost: 3400,
  impression_done: true,
} as unknown as AitoTask;

const services: AitoShippingService[] = [
  { key: 'tuamotu', name: 'Livraison Avion Tuamotu', rate: 3200, islands: [{ key: 'rangiroa', label: 'Rangiroa' }] },
];

const seed = () =>
  seedFromProject({ project, tasks: [taskDraftFromAitoTask(task)], services, defaultContactId: 'walk-in' });

describe('seedFromProject', () => {
  it('copies every task as a fresh, unticked draft with its quoted figures intact', () => {
    const [copy] = seed().tasks;
    expect(copy.id).toBeNull();
    expect(copy.uid).not.toBe('server-41');
    expect(copy.done).toEqual({ scan: false, modelisation: false, impression: false, usinage: false });
    expect(copy.title).toBe('Support GoPro');
    expect(copy.scanCost).toBe(1000);
    expect(copy.impression).toMatchObject({ printerId: 3, filamentId: 7, weightG: 42, timeMin: 180, quantity: 2, color: 'noir' });
    expect(copy.impressionCost).toBe(3400);
  });

  it('drops blank rows and falls back to one empty row when nothing is left', () => {
    const out = seedFromProject({ project, tasks: [emptyTaskDraft()], services, defaultContactId: 'walk-in' });
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].id).toBeNull();
    expect(out.tasks[0].title).toBe('');
  });

  it('copies the client block including the social handle, as an untouched contact', () => {
    const client = seed().client!;
    expect(client).toMatchObject({
      id: 'z1',
      name: 'Jean-Pierre DUPONT',
      isDefault: false,
      isCompany: false,
      countryCode: '+689',
      nationalNumber: '87123456',
      email: 'jp@example.pf',
      socialNetwork: 'instagram',
      socialHandle: 'jp_dupont',
    });
    // Nothing is written back to Zoho on create unless the operator edits it.
    expect(client.touched).toEqual({ phone: false, email: false });
    expect(client.original).toMatchObject({ phone: '+689-87123456', email: 'jp@example.pf' });
  });

  it('marks the walk-in contact as the default and leaves a clientless card to the drawer', () => {
    const walkIn = seedFromProject({
      project: { ...project, client_id: 'walk-in', client_name: 'Client de passage' } as AitoProject,
      tasks: [],
      services,
      defaultContactId: 'walk-in',
    });
    expect(walkIn.client?.isDefault).toBe(true);
    const legacy = seedFromProject({
      project: { ...project, client_id: null, client_name: null } as AitoProject,
      tasks: [],
      services,
      defaultContactId: 'walk-in',
    });
    expect(legacy.client).toBeNull();
  });

  it('copies the shipment with the price re-read from the catalogue, never the old LTA', () => {
    const shipping = seed().shipping!;
    expect(shipping).toMatchObject({
      island: 'rangiroa',
      service: 'tuamotu',
      firstName: 'Jean-Pierre',
      lastName: 'DUPONT',
      countryCode: '+689',
      nationalNumber: '89645864',
      price: 3200,
      priceEdited: false,
    });
    expect('lta' in shipping).toBe(false);
    expect(shipping.blurred).toEqual({ island: false, firstName: false, lastName: false, phone: false });
    const noRate = seedFromProject({ project, tasks: [], services: [], defaultContactId: 'walk-in' });
    expect(noRate.shipping?.price).toBeNull();
    const unshipped = seedFromProject({
      project: { ...project, shipping_island: null } as AitoProject,
      tasks: [],
      services,
      defaultContactId: 'walk-in',
    });
    expect(unshipped.shipping).toBeNull();
  });

  it('keeps the description as a hand-edited summary and copies nothing about the quote, dates or flags', () => {
    const out = seed();
    expect(out.summaryText).toBe('Support de caméra, PLA noir');
    expect(out.summaryEdited).toBe(true);
    expect(out.dueDate).toBe('');
    expect(out.socialPrefilledFor).toEqual([]);
    // The persisted shape has no room for these — pin that none leaks in.
    expect(JSON.stringify(out)).not.toMatch(/EST-|urgent|2026-09-20|x\/t\/abc|123-4567/);
  });
});

describe('isBlankPersistedDraft', () => {
  const blank = () => ({
    tasks: [emptyTaskDraft()],
    client: null,
    summaryText: '',
    summaryEdited: false,
    summarySignature: '',
    shipping: null,
    dueDate: '',
  });

  it('is true for nothing stored and for a draft nobody typed into', () => {
    expect(isBlankPersistedDraft(null)).toBe(true);
    expect(isBlankPersistedDraft(blank())).toBe(true);
    expect(isBlankPersistedDraft({ ...blank(), tasks: [] })).toBe(true);
    // The drawer seeds the walk-in contact itself; that alone is not the operator's work.
    expect(isBlankPersistedDraft({ ...blank(), client: defaultClientDraft('walk-in', 'Client de passage') })).toBe(true);
  });

  it('is false once anything the operator typed is in it', () => {
    expect(isBlankPersistedDraft({ ...blank(), tasks: [{ ...emptyTaskDraft(), title: 'Capot' }] })).toBe(false);
    expect(isBlankPersistedDraft({ ...blank(), summaryText: 'Un résumé' })).toBe(false);
    expect(isBlankPersistedDraft({ ...blank(), dueDate: '2026-09-20' })).toBe(false);
    expect(isBlankPersistedDraft({ ...blank(), client: seed().client })).toBe(false);
    expect(isBlankPersistedDraft({ ...blank(), shipping: seed().shipping })).toBe(false);
  });
});
