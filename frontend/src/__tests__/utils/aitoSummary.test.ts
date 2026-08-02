import { describe, expect, it } from 'vitest';
import { buildFallbackSummary, tasksSignature } from '../../utils/aitoSummary';
import { emptyTaskDraft } from '../../utils/taskDraft';

const label = (id: string) => ({ scan: 'Scan 3D', modelisation: 'Modélisation 3D', impression: 'Impression 3D', usinage: 'Usinage' })[id] ?? id;

describe('tasksSignature', () => {
  it('changes when a service is priced and when a title changes, ignores uid', () => {
    const a = { ...emptyTaskDraft(), title: 'Capot' };
    const sig1 = tasksSignature([a]);
    expect(tasksSignature([{ ...a, uid: 'other' }])).toBe(sig1);
    expect(tasksSignature([{ ...a, scanCost: 45 }])).not.toBe(sig1);
    expect(tasksSignature([{ ...a, title: 'Capot moteur' }])).not.toBe(sig1);
  });
});

describe('buildFallbackSummary', () => {
  it('enumerates titles with their services', () => {
    const t = { ...emptyTaskDraft(), title: 'Capot', impressionCost: 120 };
    expect(buildFallbackSummary([t], label)).toBe('Capot — Impression 3D');
  });
  it('falls back to a numbered task name for a blank title', () => {
    const t = { ...emptyTaskDraft(), scanCost: 0 };
    expect(buildFallbackSummary([t], label)).toBe('Tâche 1 — Scan 3D');
  });
});
