import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildSummary, copyText } from '../../components/aito/copySummary';
import { makeProject } from '../fixtures/aitoProject';
import { taskDraftFromAitoTask } from '../../utils/taskDraft';
import { formatMoney } from '../../utils/pricing';
import type { AitoTask } from '../../api/client';
import i18n from '../../i18n';

const baseTask = {
  id: 1,
  project_id: 41,
  position: 0,
  title: '',
  scan_description: null,
  modelisation_description: null,
  impression_description: null,
  usinage_description: null,
  maindoeuvre_description: null,
  scan_cost: null,
  modelisation_cost: null,
  usinage_cost: null,
  maindoeuvre_cost: null,
  impression_printer_id: null,
  impression_filament_id: null,
  impression_weight_g: null,
  impression_time_min: null,
  impression_quantity: 1,
  impression_color: null,
  impression_cost: null,
  impression_discount_pct: null,
  scan_quantity: null,
  modelisation_quantity: null,
  usinage_quantity: null,
  scan_discount_pct: null,
  modelisation_discount_pct: null,
  usinage_discount_pct: null,
  scan_done: false,
  modelisation_done: false,
  impression_done: false,
  usinage_done: false,
  maindoeuvre_done: false,
  created_at: '2026-09-01T00:00:00',
  updated_at: '2026-09-01T00:00:00',
} as unknown as AitoTask;

const project = makeProject({
  id: 41,
  quote_number: 'DEV26-2656',
  client_name: 'Client de passage',
  description: 'Pièce carrosserie de BMW X3',
});

const tasks = [
  taskDraftFromAitoTask({ ...baseTask, id: 1, title: 'Pièce carrosserie de BMW X3', scan_cost: 3750 }),
  taskDraftFromAitoTask({ ...baseTask, id: 2, title: 'Boite pelicule', modelisation_cost: 31000 }),
];

const t = i18n.getFixedT('en');
const money = (v: number) => formatMoney(v, 'XPF');

describe('buildSummary', () => {
  it('writes the header, one line per task, the total and the tracking link, blank lines between blocks', () => {
    expect(buildSummary(project, tasks, 'XPF', 'https://shop.example/t/abc', t)).toBe(
      [
        '#41 · DEV26-2656 · Client de passage',
        'Pièce carrosserie de BMW X3',
        '',
        `- Pièce carrosserie de BMW X3 — ${money(3750)}`,
        `- Boite pelicule — ${money(31000)}`,
        `Total ${money(34750)}`,
        '',
        'https://shop.example/t/abc',
      ].join('\n'),
    );
  });

  it('ends on the total when the card has no tracking link', () => {
    expect(buildSummary(project, tasks, 'XPF', null, t)).toBe(
      [
        '#41 · DEV26-2656 · Client de passage',
        'Pièce carrosserie de BMW X3',
        '',
        `- Pièce carrosserie de BMW X3 — ${money(3750)}`,
        `- Boite pelicule — ${money(31000)}`,
        `Total ${money(34750)}`,
      ].join('\n'),
    );
  });

  it('leaves the quote number out of the header when the card has none', () => {
    const header = buildSummary({ ...project, quote_number: null }, tasks, 'XPF', null, t).split('\n')[0];
    expect(header).toBe('#41 · Client de passage');
  });
});

describe('copyText', () => {
  const setExecCommand = (fn: unknown) => {
    (document as unknown as { execCommand: unknown }).execCommand = fn;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    // Delete, not reassign: jsdom has no execCommand, and an own property set
    // to undefined would still shadow whatever a later file installs.
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('writes through navigator.clipboard when it is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('isSecureContext', true);
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to a hidden textarea and execCommand when navigator.clipboard is undefined', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined });
    let copied = '';
    const execCommand = vi.fn(() => {
      copied = document.querySelector('textarea')?.value ?? '';
      return true;
    });
    setExecCommand(execCommand);
    await expect(copyText('over http')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copied).toBe('over http');
    // The textarea does not outlive the copy.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('resolves false, without throwing, when both paths fail', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) } });
    vi.stubGlobal('isSecureContext', true);
    setExecCommand(() => {
      throw new Error('unsupported');
    });
    await expect(copyText('nope')).resolves.toBe(false);
  });
});
