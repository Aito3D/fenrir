import type { RevenueBucket } from "./types";

type Column = [string, (b: RevenueBucket) => string | number];

const SEGMENTS: Column[] = [
  ["Pro HT", (b) => b.bySegment?.pro ?? 0],
  ["Particuliers HT", (b) => b.bySegment?.particulier ?? 0],
  ["Passage HT", (b) => b.bySegment?.passage ?? 0],
  ["Non identifié HT", (b) => b.bySegment?.inconnu ?? 0],
];
const MARGIN: Column[] = [
  ["Marge HT", (b) => (b.costedHt ?? 0) - (b.cost ?? 0)],
  ["HT avec coût", (b) => b.costedHt ?? 0],
];

// Cells are period labels and numbers only, so no quoting or formula guard is needed; a column carrying Zoho text would need both.
/** The table as CSV: BOM so Excel/Sheets read UTF-8, semicolons (fr locale), plain integers, evolution in % with one decimal; the last two columns flag an in-progress bucket (its elapsed days) and an approximate TTC (`oui`). Segment and margin columns appear only when the payload carries them (they are stripped without the permission). */
export function toCsv(buckets: RevenueBucket[]): string {
  const columns: Column[] = [
    ["Période", (b) => b.label],
    ["CA HT", (b) => b.ht],
    ["CA TTC", (b) => b.ttc],
    ["Biens HT", (b) => b.goods],
    ["Services HT", (b) => b.services],
    ...(buckets.some((b) => b.bySegment !== undefined) ? SEGMENTS : []),
    ...(buckets.some((b) => b.cost !== undefined) ? MARGIN : []),
    ["Evol HT %", (b) => (b.evolution.ht == null ? "" : (b.evolution.ht * 100).toFixed(1).replace(".", ","))],
    ["Cumul HT", (b) => b.cumulative.ht],
    ["Cumul TTC", (b) => b.cumulative.ttc],
    ["Jours manquants", (b) => b.missingDays],
    ["En cours", (b) => (b.partial ? (b.elapsedDays ?? "") : "")],
    ["TTC approx", (b) => (b.ttcApprox ? "oui" : "")],
  ];
  const rows = buckets.map((b) => columns.map(([, cell]) => cell(b)).join(";"));
  return "﻿" + [columns.map(([h]) => h).join(";"), ...rows].join("\n");
}
