# File Manager: "Open in calculator" card menu entry

**Date:** 2026-08-11

## Goal

The Archives page project card has an "Open in calculator" entry in its ⋮ menu that
navigates to `/calculator` prefilled from the archive. Give the File Manager grid
card the same entry, prefilled from the library file.

Scope is the grid card's ⋮ menu only. The list view renders a row of icon buttons
rather than a menu and is left untouched.

## Background

`ArchivesPage.tsx` defines a local `CalcConfig` interface and a
`calculatorPrefillUrl(archive, calcConfig, printerName)` helper that builds
`/calculator?weight=…&time=…&quantity=1&timeSource=…`, optionally adding
`energyKwh`, and adding `filamentId` / `printerId` only when
`estimateArchiveSalePrice` reports a real name match (a fallback pick must not
silently override the user's saved calculator selection).

That helper's input is an `ArchivePricingSource` — `filament_used_grams`,
`print_time_seconds`, `filament_type`, plus optional `actual_time_seconds` and
`energy_kwh`. `LibraryFileListItem` already carries the three required fields plus
`sliced_for_model`, so a library file is structurally the same input. No backend
change is needed.

## Design

### 1. Extract the helper into `frontend/src/utils/archivePricing.ts`

That module already owns `ArchivePricingSource` and `estimateArchiveSalePrice`,
which the URL builder calls. Move `CalcConfig` and `calculatorPrefillUrl` there and
export both.

The only signature change: the final parameter generalizes from
`printerName?: string` to `printerHints: Array<string | null | undefined> = []`.
Archives currently builds `[printerName, archive.sliced_for_model]` inside the
function body; that list moves to the call sites, because File Manager has only
`[file.sliced_for_model]` to offer.

### 2. `ArchivesPage.tsx`

Delete the local `CalcConfig` and `calculatorPrefillUrl`, import them from
`utils/archivePricing`, and update both call sites — the card menu and the print-log
list menu — to pass `[printerName, archive.sliced_for_model]`. No behavior change.

### 3. `FileManagerPage.tsx`

- Add the three calculator queries (`calculatorFilaments`, `calculatorPrinters`,
  `calculatorDefaults`) with the same query keys used by ArchivesPage and
  CalculatorPage, so all three pages share one cache. Gated on
  `hasPermission('calculator:read')`, `retry: false`, `staleTime: 5 min`. Add the
  matching `calcConfig` memo, which is `null` unless filaments, printers and
  defaults are all present.
- Add a `onOpenInCalculator?: (file: LibraryFileListItem) => void` prop to `FileCard`.
- Add the menu entry between **3D Preview** and **History**, using the `Calculator`
  icon. Disabled — greyed out rather than hidden, matching every sibling entry — when
  `!hasPermission('calculator:read') || !file.filament_used_grams || !file.print_time_seconds`.
  This mirrors the archive rule.
- Wire it as
  `onOpenInCalculator={(f) => navigate(calculatorPrefillUrl(f, calcConfig, [f.sliced_for_model]))}`.

### i18n

Reuse the existing `archives.menu.openInCalculator` key, which is translated in all
13 locales with wording that is already generic ("Open in calculator"). `FileCard`
already reads keys from other namespaces (`slice.action`, `common.print`,
`library.runWithPipeline.*`), so this follows the file's existing practice and adds
no untranslated strings.

## Behavior note

Library files have no `actual_time_seconds` and no `energy_kwh`, so the generated URL
always carries `timeSource=est` and never `energyKwh`. That is correct: a library
file's print time is always a slicer estimate, so the calculator's time-accuracy
correction should apply to it.

## Testing

Add to `frontend/src/__tests__/pages/FileManagerPage.test.tsx`:

- Opening a card's ⋮ menu shows the entry; clicking it navigates to a
  `/calculator?…` URL carrying the file's `weight` and `time`.
- A file with no `filament_used_grams` / `print_time_seconds` renders the entry
  disabled.

Existing `ArchivesPage` tests cover the extracted helper's behavior and must keep
passing unchanged — that is the regression guard for step 1.
