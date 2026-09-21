import { describe, expect, it } from 'vitest';
import { maindoeuvreDescriptionError, tasksMissingMaindoeuvreDescription } from '../../utils/maindoeuvreValidation';
import { emptyTaskDraft } from '../../utils/taskDraft';

describe('maindoeuvreDescriptionError', () => {
  it('is null when the labour step is absent', () => {
    expect(maindoeuvreDescriptionError(emptyTaskDraft())).toBeNull();
  });

  it('reports a priced labour step with no description', () => {
    expect(maindoeuvreDescriptionError({ ...emptyTaskDraft(), maindoeuvreCost: 4000 })).toBe(
      'aito.maindoeuvreDescriptionRequired',
    );
  });

  it('reports a FREE labour step with no description — 0 is a real step', () => {
    expect(maindoeuvreDescriptionError({ ...emptyTaskDraft(), maindoeuvreCost: 0 })).toBe(
      'aito.maindoeuvreDescriptionRequired',
    );
  });

  it('treats whitespace as blank', () => {
    expect(
      maindoeuvreDescriptionError({ ...emptyTaskDraft(), maindoeuvreCost: 4000, maindoeuvreDescription: '   ' }),
    ).toBe('aito.maindoeuvreDescriptionRequired');
  });

  it('is null once the description is filled', () => {
    expect(
      maindoeuvreDescriptionError({ ...emptyTaskDraft(), maindoeuvreCost: 4000, maindoeuvreDescription: 'Pose' }),
    ).toBeNull();
  });

  it('finds the offending task in a list', () => {
    const ok = { ...emptyTaskDraft(), maindoeuvreCost: 1, maindoeuvreDescription: 'Pose' };
    const bad = { ...emptyTaskDraft(), maindoeuvreCost: 1 };
    expect(tasksMissingMaindoeuvreDescription([ok])).toBe(false);
    expect(tasksMissingMaindoeuvreDescription([ok, bad])).toBe(true);
  });
});
