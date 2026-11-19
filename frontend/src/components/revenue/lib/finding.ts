export type FindingCase = "targetAhead" | "targetBehind" | "targetLevel" | "target" | "ahead" | "behind" | "level";

/** Under half a percent either way: shown as flat, as the delta badge does. */
export const isLevel = (change: number) => Math.abs(change) < 0.005;

const direction = (change: number) => (isLevel(change) ? "Level" : change > 0 ? "Ahead" : "Behind");

/** Which sentence opens the Évolution view: share of the target and/or the change vs the previous period; null when neither exists. */
export function findingCase(share: number | null, change: number | null): FindingCase | null {
  if (share != null) return change == null ? "target" : `target${direction(change)}`;
  if (change == null) return null;
  return direction(change).toLowerCase() as "ahead" | "behind" | "level";
}
