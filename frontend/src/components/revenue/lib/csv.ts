import type { RevenueBucket } from "./types";

// Cells are period labels and numbers only, so no quoting or formula guard is needed; a column carrying Zoho text would need both.
/** The table as CSV: BOM so Excel/Sheets read UTF-8, semicolons (fr locale), plain integers, evolution in % with one decimal; the last two columns flag an in-progress bucket (its elapsed days) and an approximate TTC (`oui`). */
export function toCsv(buckets: RevenueBucket[]): string {
  const header =
    "Période;CA HT;CA TTC;Biens HT;Services HT;Pro HT;Particuliers HT;Passage HT;Non identifié HT;Marge HT;HT avec coût;Evol HT %;Cumul HT;Cumul TTC;Jours manquants;En cours;TTC approx";
  const rows = buckets.map((b) =>
    [
      b.label,
      b.ht,
      b.ttc,
      b.goods,
      b.services,
      b.bySegment?.pro ?? 0,
      b.bySegment?.particulier ?? 0,
      b.bySegment?.passage ?? 0,
      b.bySegment?.inconnu ?? 0,
      (b.costedHt ?? 0) - (b.cost ?? 0),
      b.costedHt ?? 0,
      b.evolution.ht == null ? "" : (b.evolution.ht * 100).toFixed(1).replace(".", ","),
      b.cumulative.ht,
      b.cumulative.ttc,
      b.missingDays,
      b.partial ? (b.elapsedDays ?? "") : "",
      b.ttcApprox ? "oui" : "",
    ].join(";"),
  );
  return "﻿" + [header, ...rows].join("\n");
}
