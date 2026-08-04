import type { TaskDraft } from './taskDraft';

type ServiceId = 'scan' | 'modelisation' | 'impression' | 'usinage';

function enabledServices(task: TaskDraft): string[] {
  return [
    task.scanCost !== null ? 'scan' : null,
    task.modelisationCost !== null ? 'modelisation' : null,
    task.impressionCost !== null ? 'impression' : null,
    task.usinageCost !== null ? 'usinage' : null,
  ].filter((s): s is ServiceId => s !== null);
}

/** Stable fingerprint of what the AI summary describes: titles, per-service
 *  descriptions, enabled services, and the visible impression parameters.
 *  Deliberately excludes uid/id (identity, not content) and prices (the
 *  summary never mentions money). */
export function tasksSignature(tasks: TaskDraft[]): string {
  return JSON.stringify(
    tasks.map((t) => [
      t.title.trim(),
      t.scanDescription.trim(),
      t.modelisationDescription.trim(),
      t.impressionDescription.trim(),
      t.usinageDescription.trim(),
      enabledServices(t),
      t.impressionCost !== null
        ? [t.impression.color, t.impression.weightG, t.impression.timeMin, t.impression.quantity]
        : null,
    ]),
  );
}

/** Manual-mode seed when OpenRouter is unavailable: "title — Service, Service"
 *  per task, joined with "; ". Never empty for a non-empty task list. */
export function buildFallbackSummary(tasks: TaskDraft[], serviceLabel: (id: string) => string): string {
  return tasks
    .map((t, index) => {
      const name = t.title.trim() || `Tâche ${index + 1}`;
      const services = enabledServices(t).map(serviceLabel);
      return services.length ? `${name} — ${services.join(', ')}` : name;
    })
    .join(' ; ');
}
