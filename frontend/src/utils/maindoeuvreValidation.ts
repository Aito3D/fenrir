import type { TaskDraft } from './taskDraft';

/** Main d'œuvre is the one service whose description is MANDATORY: a labour
 *  line says nothing on the quote without it, where a scan line is already
 *  described by its own name.
 *
 *  Returns an i18n key (the convention `FieldError` takes) or null. The test
 *  is `!== null` on the cost, never falsiness: a labour step quoted free is a
 *  real step and still has to say what the work was.
 *
 *  Its own module rather than a method on TaskDraft: both the editor block and
 *  the create drawer's Create gate read it, and the backend's push guard
 *  (services/aito_quote_export.missing_maindoeuvre_description) is its mirror
 *  — three callers, one rule. */
export function maindoeuvreDescriptionError(task: TaskDraft): string | null {
  if (task.maindoeuvreCost === null) return null;
  return task.maindoeuvreDescription.trim() === '' ? 'aito.maindoeuvreDescriptionRequired' : null;
}

/** True when any task in the list carries a priced labour step with no
 *  description — what the create drawer gates on. */
export function tasksMissingMaindoeuvreDescription(tasks: readonly TaskDraft[]): boolean {
  return tasks.some((task) => maindoeuvreDescriptionError(task) !== null);
}
