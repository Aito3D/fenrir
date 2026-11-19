export type FindingCase = "targetAhead" | "targetBehind" | "target" | "ahead" | "behind";

/** Which sentence opens the Évolution view: share of the target and/or the change vs the previous period; null when neither exists. */
export function findingCase(share: number | null, change: number | null): FindingCase | null {
  if (share != null) return change == null ? "target" : change >= 0 ? "targetAhead" : "targetBehind";
  if (change == null) return null;
  return change >= 0 ? "ahead" : "behind";
}
