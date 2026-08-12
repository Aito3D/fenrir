# Aito: quantity / material / colour on the printing step

**Date:** 2026-08-11

## Goal

On the expanded project card, a task's **Printing** step should show the part's
quantity, material and colour beside it — each only when actually set.

## Design (chosen from a demo of seven variations, option "C6")

The values render on a **line of its own under the step row**, in the same gutter
the step description already uses, as **icon + value** pairs:

```
☐ │ Printing                                  12 000 F
     ⧉ ×3   ▣ PLA Basique   ◐ Rouge
     Remplissage 40 %, supports arbre.          ← existing description, if any
```

Rejected alternatives, all sharing the same sub-line frame: plain middot-separated
text (reads as one sentence, not three facts); bordered or filled pills (heavier
than anything else in a panel built on restraint); a quantity-only pill; labelled
pills (`Qté` / `Matière` / `Couleur` — widest, and three new strings in thirteen
locales); stage-tinted pills (spends the board's orange "print" signal on
descriptive text).

Also rejected earlier, before the sub-line frame was settled: inline after the
label (shares one truncation budget with the label), and right of the label before
the price (the right edge belongs to the money column).

### Rendering rules

- Only on the `impression` step. Other services render exactly as today.
- The line renders only when at least one of the three values is present. It is
  absent entirely otherwise — no empty row, no placeholder dashes.
- **Quantity** shows only when `> 1`. Every draft carries a quantity defaulting to
  1, so `×1` is noise. Rendered as `×3`, tabular-nums.
- **Material** is the calculator filament's name, resolved from
  `impression.filamentId`. Absent when the id is null or the filament list has not
  resolved (see below).
- **Colour** is `impression.color` trimmed; absent when blank.
- Icons are `Layers` (quantity), `Box` (material), `Palette` (colour) from
  lucide-react, `aria-hidden`, at the same 0.75rem the description uses. Each pair
  carries an `sr-only` field name (`aito.quantity` / `aito.material` /
  `aito.color`, all already translated) so the line is not a bare string of values
  to a screen reader, plus a `title` for pointer users.
- Long values truncate per item rather than pushing the row; the line wraps.

### Where the material name comes from

The task stores only `filamentId`; the name lives in the calculator's filament
list. `TaskRow`'s doc comment records that read mode deliberately runs **none** of
`ImpressionFields`' three reference-data queries, so this adds one:

- `TaskStepList` queries `['calculatorFilaments']` — the same key, and therefore
  the same cache, that `ImpressionFields`, `CalculatorPage`, `ArchivesPage` and
  `FileManagerPage` use. React Query dedupes across task rows, so N tasks issue one
  request.
- `enabled` only when this task actually has a printing step with a non-null
  `filamentId`, so a board of tasks without printing fetches nothing.
- `retry: false`, `staleTime: 60_000`, matching `ImpressionFields`.
- No permission gate: a user without `calculator:read` gets a 403, the query stays
  empty, and the material simply never renders — the same graceful degradation an
  unconfigured install already gets. Quantity and colour are unaffected; they live
  on the task itself.

## Testing

`frontend/src/__tests__/components/AitoTaskStepList.test.tsx`:

- renders quantity, material and colour on the printing step when all are set
- omits quantity at 1, omits blank colour, omits material when `filamentId` is null
- renders no meta line at all when nothing is set
- never renders the line on a non-printing step
- coexists with an existing step description (both render, in that order)
- does not fetch filaments when no printing step has a `filamentId`
