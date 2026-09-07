# Phase 1 coverage baseline

Recorded 2026-09-07 on commit `ef8194bbc74db308031eefb76be99914b16e7383` (tip
of `worktree-aito-calc-test-hardening` at the time of this task, before the
Task 7 commit). No later phase may lower any number here.

| Scope | Statements | Branches | Command |
| --- | --- | --- | --- |
| Aito backend | 99.05% (2926/2954) | 95.97% (739/770) | `bash tools/coverage_aito.sh backend` |
| Calculator backend | 99.78% (906/908) | 98.54% (203/206) | `bash tools/coverage_calc.sh backend` |
| Aito frontend | 92.13% (2742/2976) | 90.92% (2604/2864) | `bash tools/coverage_aito.sh frontend` |
| Calculator frontend | 97.12% (1418/1460) | 91.2% (1192/1307) | `bash tools/coverage_calc.sh frontend` |

All four numbers were produced by running the command in that row directly
(no editing of the tools' own printed totals). The two frontend scopes are
reported separately because `coverage_aito.sh` and `coverage_calc.sh` each
scope and run their own frontend Vitest pass with a different `--coverage
.include` set — there is no single command that emits one combined frontend
number, so none is fabricated here.

The Aito frontend run's coverage numbers were double-checked by re-running
the same Vitest command with the same `--coverage.include` set and writing
the full log to a file instead of tailing it: both runs report identical
totals (92.13% / 90.92%), including the run in which
`ArchivesPage.test.tsx` flaked (see below) — the flake does not move the
coverage figures.

## Pre-phase-1 reference (2026-09-07, before any property test)

Measured before Tasks 1-6 touched anything, using the pre-Task-7 coverage
scripts (before `projectSeed.ts` was added to the Aito frontend scope):

- Aito backend: 99.02% statements, 95.84% branches
- Calculator backend: 99.78% statements, 98.54% branches
- Both frontends combined: 94.10% statements, 91.17% branches

The backend numbers are directly comparable to the table above (backend
scope did not change in Task 7) and both improved or held steady. The
frontend reference was a combined figure across both scopes using an older
version of `coverage_aito.sh` that did not yet include `projectSeed.ts`; the
table above supersedes it with the current, separately-scoped numbers now
that the scope hole is closed.

## Test run notes

- `ArchivesPage.test.tsx` failed once, on a run alongside the full Aito
  frontend scope (`Unable to find an element with the text: Download
  failed: Not enough app data volume space...`), then passed 43/43 when
  re-run alone. This matches the documented load-flake list
  (`PrintModal`, `ArchivesPage`, `FileUploadModal`, `SlicerSettingsPanel`,
  `AitoPage`) and is not a regression.
