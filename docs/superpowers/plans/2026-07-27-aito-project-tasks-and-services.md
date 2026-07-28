# Aito Project Tasks and Services — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an Aito project a list of tasks, each with an optional title/description and four optional services — Scan3D, Modelisation3D, Usinage (a single cost each) and Impression3D (printer, material, weight, time, colour, quantity, with its cost computed by the existing pricing engine). Tasks are built in the create modal and fully editable from the detail panel.

**Architecture:** All the real logic lives in one pure module (`utils/taskDraft.ts`) that composes on top of `computePricing` without modifying it. The backend stores tasks in a single flat table — the four services are a fixed set, so columns beat an EAV child table. One presentational `TaskEditor` serves two data flows: the create modal holds an array in state and POSTs it with the project; the detail panel wires each change to a PATCH.

**Tech Stack:** FastAPI + SQLAlchemy + Pydantic, pytest; React 19 + TanStack Query + Tailwind 4, Vitest + Testing Library + MSW.

**Spec:** `docs/superpowers/specs/2026-07-27-aito-project-tasks-and-services-design.md` — read it before Task 1. Two decisions in it change money and must not be "tidied" away: the per-job flats are zeroed per task, and the stored figure is `total_ttc_qty`.

## Codebase baseline

Verified against `65433ee5d` (2026-07-27).

| Fact | Detail |
|---|---|
| `computePricing` | `frontend/src/utils/pricing.ts`; returns a **per-unit** `PricingResult` plus `total_ht_qty` / `total_ttc_qty` |
| Calculator headline | `CalculatorTotalsCard` leads with `total_ttc`, and `total_ttc_qty` when quantity > 1 |
| Filament/printer sources | `api.getCalculatorFilaments()`, `api.getCalculatorPrinters()`, `api.getCalculatorDefaults()` |
| `CalculatorFilament` | `{id, name, brand, material, cost_per_kg, sale_price_per_kg, difficulty_pct, …}` — a superset of `PricingFilament` |
| `CalculatorPrinter` | `{id, name, purchase_price, lifetime_years, daily_usage_hours, power_watts, repair_rate_pct, …}` — a superset of `PricingPrinter` |
| **Model registration** | **Four** places, not three: `models/__init__.py` import, `models/__init__.py` `__all__`, `database.py` `init_db()` import list, and `backend/tests/conftest.py`'s import list |
| `update_project` PATCH semantics | `model_dump(exclude_unset=True)`, write only present keys — the pattern task PATCH must copy |
| `DeleteHoldButton` | `frontend/src/components/aito/DeleteHoldButton.tsx`, reusable as-is |

## Global Constraints

- Python line length 120; Ruff `E, W, F, I, B, C4, UP, ARG, SIM`; double quotes; Python 3.10 target.
- Use `./venv/bin/python3` for Python. `ruff` is on PATH.
- TypeScript strict, no unused locals/parameters, ES2022.
- All commands run **from the project root**.
- Schema changes are additive statements inside `run_migrations()` in `backend/app/core/database.py`, wrapped in `_safe_execute`. No migration framework.
- New user-facing strings need a key in **all 12** locale files, genuinely translated. `frontend/src/__tests__/i18n/locales.test.ts` enforces `en` parity against `de, fr, it, ja, pt-BR, zh-CN` and fails on extras as well as omissions. `frontend/scripts/check-i18n-parity.mjs` additionally fails when a non-English value is byte-identical to English — the four service names are product names and must be added to its allowlist rather than translated.
- **`frontend/src/utils/pricing.ts` must not be modified.** The calculator page depends on it; this feature composes on top.
- **Known pre-existing failures, not yours:** a repo-wide `ruff format --check` fails on 6 unrelated files (`camera.py`, `library.py`, `test_camera_api.py`, `test_library_file_history_api.py`, `test_aito_project_model.py`, `test_camera_chamber_stream.py`) — do not reformat them; 2 tests in `test_extract_video_last_frame.py` fail from a missing `/usr/bin/ffmpeg`. Verify the backend with `./venv/bin/python3 -m pytest backend/tests/unit/ -q && ruff check backend/`.
- Known frontend flakes that pass on isolated re-run: `PrintModal.test.tsx`, and `AitoPage.test.tsx` on `scrollIntoView`.
- **Working tree:** `static/index.html` and the untracked `frontend/src/__tests__/components/ViewTransitionWiring.test.tsx` belong to the repo owner. Stage by explicit path; never `git add -A`, `git add .` or `git add frontend/src`.
- Commit after every task. Do not push.

---

## File Structure

**Create:**

| File | Task | Responsibility |
|---|---|---|
| `frontend/src/utils/taskDraft.ts` | 2 | `TaskDraft` type and every pure helper |
| `frontend/src/__tests__/utils/taskDraft.test.ts` | 2 | Its tests |
| `backend/app/models/aito_task.py` | 3 | The `AitoTask` model |
| `frontend/src/components/aito/DurationInput.tsx` | 6 | d/h/m → total minutes |
| `frontend/src/components/aito/ImpressionFields.tsx` | 6 | Six inputs + live breakdown |
| `frontend/src/components/aito/TaskRow.tsx` | 7 | One task |
| `frontend/src/components/aito/TaskEditor.tsx` | 7 | The list + "Add task" |
| `frontend/src/__tests__/components/TaskEditor.test.tsx` | 7 | Component tests |

**Modify:** `backend/app/schemas/aito.py`, `backend/app/api/routes/aito.py`, `backend/app/core/database.py`, `backend/app/models/__init__.py`, `backend/tests/conftest.py`, `backend/tests/unit/test_aito_routes.py`, `frontend/src/api/client.ts`, `frontend/src/components/aito/NewProjectModal.tsx`, `frontend/src/components/aito/ProjectDetailPanel.tsx`, `frontend/src/pages/AitoPage.tsx`, `frontend/src/i18n/locales/*.ts` (12), `frontend/scripts/check-i18n-parity.mjs`.

---

### Task 1: i18n keys

Added first so every later task can reference keys without breaking locale parity mid-stream.

**Files:** all 12 `frontend/src/i18n/locales/*.ts`, `frontend/scripts/check-i18n-parity.mjs`

**Interfaces:** produces the `aito.*` keys below.

- [ ] **Step 1: Add the English keys**

Inside the `aito` block of `frontend/src/i18n/locales/en.ts`:

```ts
    tasks: 'Tasks',
    addTask: 'Add task',
    taskFallbackName: 'Task {{n}}',
    taskTitlePlaceholder: 'Optional title',
    taskDescriptionPlaceholder: 'Optional description',
    removeTask: 'Remove task',
    serviceScan3D: 'Scan3D',
    serviceModelisation3D: 'Modelisation3D',
    serviceImpression3D: 'Impression3D',
    serviceUsinage: 'Usinage',
    serviceCost: 'Cost',
    printer: 'Printer',
    material: 'Material',
    weightG: 'Weight (g)',
    printTime: 'Print time',
    color: 'Colour',
    quantity: 'Quantity',
    taskTotal: 'Task total',
    projectTotal: 'Project total',
    noPrintersConfigured: 'No printers configured in the calculator yet.',
    noFilamentsConfigured: 'No filaments configured in the calculator yet.',
```

- [ ] **Step 2: Add the French keys**

```ts
    tasks: 'Tâches',
    addTask: 'Ajouter une tâche',
    taskFallbackName: 'Tâche {{n}}',
    taskTitlePlaceholder: 'Titre (facultatif)',
    taskDescriptionPlaceholder: 'Description (facultative)',
    removeTask: 'Supprimer la tâche',
    serviceScan3D: 'Scan3D',
    serviceModelisation3D: 'Modelisation3D',
    serviceImpression3D: 'Impression3D',
    serviceUsinage: 'Usinage',
    serviceCost: 'Coût',
    printer: 'Imprimante',
    material: 'Matériau',
    weightG: 'Poids (g)',
    printTime: 'Temps d’impression',
    color: 'Couleur',
    quantity: 'Quantité',
    taskTotal: 'Total tâche',
    projectTotal: 'Total projet',
    noPrintersConfigured: 'Aucune imprimante configurée dans la calculatrice.',
    noFilamentsConfigured: 'Aucun filament configuré dans la calculatrice.',
```

> **Do not add `days` / `hours` / `minutes` keys.** `calculator.durationDaysShort`,
> `durationHoursShort` and `durationMinutesShort` already exist in all 12 locale
> files, already translated, and are already used by `CalculatorInputsCard` and
> `CalculatorLaborCard` for exactly this purpose — a compact unit suffix beside
> a numeric input. `DurationInput` consumes those. Duplicating them under
> `aito.*` is how the first attempt at this task ended up with `ja` rendering
> `時間` where the calculator renders `時`.

- [ ] **Step 3: Translate into the remaining ten locales**

`de, es, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`. Keep `{{n}}` intact.

**The four `service*` keys are product names — the workshop's own service catalogue — and stay identical in every locale.** Translate everything else genuinely.

- [ ] **Step 4: Allowlist the service names in the parity script**

`frontend/scripts/check-i18n-parity.mjs` fails when a non-English value is byte-identical to English. Add `Scan3D`, `Modelisation3D`, `Impression3D` and `Usinage` to the brand/technical-name alternation in `isAlwaysAllowedIdentical` — the same list that already carries `Zoho`, `Bambuddy` and `OrcaSlicer`. Do **not** use a shape-based rule; scope it to these exact names.

- [ ] **Step 5: Verify and commit**

Run: `cd frontend && npx vitest run src/__tests__/i18n/locales.test.ts && node scripts/check-i18n-parity.mjs && cd ..`
Expected: PASS.

```bash
git add frontend/src/i18n/locales frontend/scripts/check-i18n-parity.mjs
git commit -m "i18n(aito): keys for project tasks and their four services"
```

---

### Task 2: The pure task module

Everything with real logic lives here so it can be tested without rendering or a database. This is the highest-leverage task in the plan — six later tasks consume it.

**Files:**
- Create: `frontend/src/utils/taskDraft.ts`, `frontend/src/__tests__/utils/taskDraft.test.ts`

**Interfaces:**
- Consumes: `computePricing`, `PricingFilament`, `PricingPrinter`, `PricingDefaults`, `PricingResult` from `frontend/src/utils/pricing.ts` — **read-only, that file is not modified**.
- Produces:

```ts
export interface ImpressionDraft {
  printerId: number | null;
  filamentId: number | null;
  weightG: number | null;
  timeMin: number | null;
  quantity: number;
  color: string;
}
export interface TaskDraft {
  /** Server id once persisted; null for a task not yet saved. */
  id: number | null;
  title: string;
  description: string;
  scanCost: number | null;
  modelisationCost: number | null;
  usinageCost: number | null;
  impression: ImpressionDraft;
  /** Frozen total for a saved task; recomputed while editing. */
  impressionCost: number | null;
}
export function emptyTaskDraft(): TaskDraft;
export function splitMinutes(total: number): { days: number; hours: number; minutes: number };
export function joinMinutes(parts: { days: number; hours: number; minutes: number }): number;
export function computeImpressionCost(
  impression: ImpressionDraft,
  filament: PricingFilament | null,
  printer: PricingPrinter | null,
  defaults: PricingDefaults,
): PricingResult | null;
export function taskTotal(task: TaskDraft): number;
export function projectTotal(tasks: TaskDraft[]): number;
```

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/__tests__/utils/taskDraft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  emptyTaskDraft,
  splitMinutes,
  joinMinutes,
  computeImpressionCost,
  taskTotal,
  projectTotal,
} from '../../utils/taskDraft';
import type { PricingDefaults, PricingFilament, PricingPrinter } from '../../utils/pricing';

const filament: PricingFilament = { cost_per_kg: 3000, sale_price_per_kg: 6000, difficulty_pct: 100 };
const printer: PricingPrinter = {
  purchase_price: 300000,
  lifetime_years: 5,
  daily_usage_hours: 8,
  power_watts: 150,
  repair_rate_pct: 5,
};
const defaults: PricingDefaults = {
  electricity_tariff: 30,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 500,
  failure_rate_pct: 5,
  prototype_rate_pct: 5,
  ads_rate_pct: 3,
  filament_markup_pct: 50,
  global_markup_pct: 30,
  tax_pct: 0,
  default_difficulty_pct: 100,
  stuff_markup_pct: 20,
  base_fee_flat: 2000,
};

const impression = {
  printerId: 1,
  filamentId: 1,
  weightG: 120,
  timeMin: 270,
  quantity: 1,
  color: 'Noir',
};

describe('splitMinutes / joinMinutes', () => {
  it.each([
    [0, { days: 0, hours: 0, minutes: 0 }],
    [90, { days: 0, hours: 1, minutes: 30 }],
    [270, { days: 0, hours: 4, minutes: 30 }],
    [1500, { days: 1, hours: 1, minutes: 0 }],
  ])('splits %i minutes', (total, expected) => {
    expect(splitMinutes(total)).toEqual(expected);
  });

  it('round-trips', () => {
    for (const total of [0, 1, 59, 60, 90, 270, 1439, 1440, 1500]) {
      expect(joinMinutes(splitMinutes(total))).toBe(total);
    }
  });
});

describe('computeImpressionCost', () => {
  it.each([
    ['printer', { printerId: null }],
    ['filament', { filamentId: null }],
    ['weight', { weightG: null }],
    ['time', { timeMin: null }],
  ])('returns null when %s is missing', (_label, patch) => {
    expect(
      computeImpressionCost({ ...impression, ...patch }, filament, printer, defaults),
    ).toBeNull();
  });

  it('returns null when the filament or printer record is unavailable', () => {
    expect(computeImpressionCost(impression, null, printer, defaults)).toBeNull();
    expect(computeImpressionCost(impression, filament, null, defaults)).toBeNull();
  });

  it('zeroes the per-job flats so a project is not charged them per print', () => {
    // The engine treats base_fee_flat and consumables_packaging_flat as
    // one-time per JOB. A project is the job, so a task must not carry them —
    // three print tasks would otherwise be charged them three times.
    const withFlats = computeImpressionCost(impression, filament, printer, defaults);
    const withoutFlats = computeImpressionCost(impression, filament, printer, {
      ...defaults,
      base_fee_flat: 0,
      consumables_packaging_flat: 0,
    });
    expect(withFlats!.total_ttc_qty).toBeCloseTo(withoutFlats!.total_ttc_qty, 6);
    expect(withFlats!.base_fee_total).toBe(0);
    expect(withFlats!.consumables_flat).toBe(0);
  });

  it('excludes labour, which the sibling services carry', () => {
    const r = computeImpressionCost(impression, filament, printer, defaults)!;
    expect(r.modeling_cost_total).toBe(0);
    expect(r.prep_cost_total).toBe(0);
    expect(r.post_processing_cost).toBe(0);
    expect(r.stuff_cost).toBe(0);
  });

  it('multiplies the line total by quantity', () => {
    const one = computeImpressionCost(impression, filament, printer, defaults)!;
    const two = computeImpressionCost({ ...impression, quantity: 2 }, filament, printer, defaults)!;
    expect(two.total_ttc_qty).toBeCloseTo(one.total_ttc_qty * 2, 6);
  });

  it('treats a missing or zero quantity as 1', () => {
    const one = computeImpressionCost(impression, filament, printer, defaults)!;
    const zero = computeImpressionCost({ ...impression, quantity: 0 }, filament, printer, defaults)!;
    expect(zero.total_ttc_qty).toBeCloseTo(one.total_ttc_qty, 6);
  });
});

describe('taskTotal / projectTotal', () => {
  const base = emptyTaskDraft();

  it('sums only enabled services', () => {
    expect(taskTotal({ ...base, scanCost: 4000, usinageCost: 12000 })).toBe(16000);
  });

  it('treats null as disabled and 0 as free', () => {
    expect(taskTotal(base)).toBe(0);
    expect(taskTotal({ ...base, scanCost: 0 })).toBe(0);
    expect(taskTotal({ ...base, scanCost: null, modelisationCost: 500 })).toBe(500);
  });

  it('includes the frozen impression cost', () => {
    expect(taskTotal({ ...base, scanCost: 1000, impressionCost: 4200 })).toBe(5200);
  });

  it('sums tasks', () => {
    expect(projectTotal([{ ...base, scanCost: 1000 }, { ...base, usinageCost: 2000 }])).toBe(3000);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/utils/taskDraft.test.ts && cd ..`
Expected: FAIL — cannot resolve `../../utils/taskDraft`.

- [ ] **Step 3: Create the module**

```ts
import { computePricing } from './pricing';
import type { PricingDefaults, PricingFilament, PricingPrinter, PricingResult } from './pricing';

export interface ImpressionDraft {
  printerId: number | null;
  filamentId: number | null;
  weightG: number | null;
  timeMin: number | null;
  quantity: number;
  color: string;
}

/** One task of a project. `id` is null until the row exists server-side, which
 *  is what lets the same editor serve the create modal (drafts) and the detail
 *  panel (persisted rows). */
export interface TaskDraft {
  id: number | null;
  title: string;
  description: string;
  /** null = the service is disabled. 0 stays meaningful as "free". */
  scanCost: number | null;
  modelisationCost: number | null;
  usinageCost: number | null;
  impression: ImpressionDraft;
  /** Frozen total for a saved task; recomputed while the task is being edited. */
  impressionCost: number | null;
}

export function emptyTaskDraft(): TaskDraft {
  return {
    id: null,
    title: '',
    description: '',
    scanCost: null,
    modelisationCost: null,
    usinageCost: null,
    impression: { printerId: null, filamentId: null, weightG: null, timeMin: null, quantity: 1, color: '' },
    impressionCost: null,
  };
}

export function splitMinutes(total: number): { days: number; hours: number; minutes: number } {
  const t = Math.max(0, Math.floor(total || 0));
  return { days: Math.floor(t / 1440), hours: Math.floor((t % 1440) / 60), minutes: t % 60 };
}

export function joinMinutes(parts: { days: number; hours: number; minutes: number }): number {
  return Math.max(0, Math.floor(parts.days || 0)) * 1440
    + Math.max(0, Math.floor(parts.hours || 0)) * 60
    + Math.max(0, Math.floor(parts.minutes || 0));
}

/** Impression3D's cost, through the same engine the calculator page uses.
 *
 *  Two departures from a calculator quote, both deliberate:
 *  - The per-job flats (`base_fee_flat`, `consumables_packaging_flat`) are
 *    zeroed. The engine treats them as one-time per JOB; a project is the job,
 *    so a project with three print tasks would otherwise be charged them three
 *    times, silently.
 *  - Modelling, prep, post-processing and extras are zero. Modelisation3D is
 *    its own service line, so including modelling here would double-count it;
 *    the rest are not captured by this form at all.
 *
 *  Returns null when the service is disabled — any of printer, filament,
 *  weight or time missing. */
export function computeImpressionCost(
  impression: ImpressionDraft,
  filament: PricingFilament | null,
  printer: PricingPrinter | null,
  defaults: PricingDefaults,
): PricingResult | null {
  const { printerId, filamentId, weightG, timeMin } = impression;
  if (printerId === null || filamentId === null || weightG === null || timeMin === null) return null;
  if (!filament || !printer) return null;

  return computePricing(
    {
      weight_g: weightG,
      printing_time_h: timeMin / 60,
      quantity: Math.max(1, Math.floor(impression.quantity || 1)),
      modeling_hours: 0,
      modeling_base_price: 0,
      prep_model_min: 0,
      prep_slicing_min: 0,
      prep_transfer_min: 0,
      post_removal_min: 0,
      post_support_min: 0,
      post_additional_min: 0,
      post_fulfillment_min: 0,
      stuff_amount: 0,
      stuff_markup_pct: 0,
    },
    filament,
    printer,
    { ...defaults, base_fee_flat: 0, consumables_packaging_flat: 0 },
  );
}

const orZero = (n: number | null) => n ?? 0;

export function taskTotal(task: TaskDraft): number {
  return orZero(task.scanCost) + orZero(task.modelisationCost) + orZero(task.usinageCost)
    + orZero(task.impressionCost);
}

export function projectTotal(tasks: TaskDraft[]): number {
  return tasks.reduce((sum, t) => sum + taskTotal(t), 0);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx vitest run src/__tests__/utils/taskDraft.test.ts && npx tsc --noEmit -p tsconfig.app.json && cd ..`
Expected: PASS.

- [ ] **Step 5: Prove the flats test can fail**

Remove `base_fee_flat: 0, consumables_packaging_flat: 0` from the defaults override and re-run. `zeroes the per-job flats so a project is not charged them per print` must FAIL. Restore, confirm `git diff` shows the file as intended, and re-run to green. Report the observed output of both runs — this decision is the one most likely to be "simplified" away by a future reader, and the test is its only guard.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/utils/taskDraft.ts frontend/src/__tests__/utils/taskDraft.test.ts
git commit -m "feat(aito): pure task drafts and Impression3D cost composition"
```

---

### Task 3: The `aito_tasks` table

**Files:**
- Create: `backend/app/models/aito_task.py`
- Modify: `backend/app/models/__init__.py`, `backend/app/core/database.py`, `backend/tests/conftest.py`
- Test: `backend/tests/unit/test_aito_tasks_model.py` (new)

**Interfaces:** produces the `AitoTask` model.

> **A new model must be registered in FOUR places, not three.** Missing the fourth means the table does not exist in tests and every later task fails with a confusing `no such table` rather than a clear error. They are enumerated in Step 3.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/unit/test_aito_tasks_model.py`:

```python
"""The aito_tasks table exists with the columns the API depends on."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_task import AitoTask


@pytest.mark.asyncio
async def test_task_row_round_trips(db_session):
    task = AitoTask(
        project_id=1,
        position=0,
        title="Boîtier",
        description="Deux pièces",
        scan_cost=4000.0,
        impression_printer_id=7,
        impression_filament_id=3,
        impression_weight_g=120.0,
        impression_time_min=270,
        impression_quantity=2,
        impression_color="Noir",
        impression_cost=8400.0,
    )
    db_session.add(task)
    await db_session.commit()

    row = (await db_session.execute(select(AitoTask))).scalar_one()
    assert row.title == "Boîtier"
    assert row.scan_cost == 4000.0
    # Unset services stay NULL — that is how "disabled" is stored.
    assert row.modelisation_cost is None
    assert row.usinage_cost is None
    assert row.impression_quantity == 2
```

- [ ] **Step 2: Run to verify it fails**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_tasks_model.py -v`
Expected: FAIL — `ModuleNotFoundError: backend.app.models.aito_task`

- [ ] **Step 3: Create the model and register it in all four places**

`backend/app/models/aito_task.py`:

```python
from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class AitoTask(Base):
    """One task of an Aito project, with four optional services.

    The services are a fixed, known set, so they are columns rather than an EAV
    child table. A NULL cost means the service is disabled; 0 stays meaningful
    as "free".

    ``impression_printer_id`` and ``impression_filament_id`` are deliberately
    NOT foreign keys: deleting a filament from the calculator must not cascade
    into a historical quote. ``impression_cost`` is already frozen, so a
    dangling reference costs only the ability to re-edit that line.
    """

    __tablename__ = "aito_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str | None] = mapped_column(String(200), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    scan_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    modelisation_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    usinage_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    impression_printer_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_filament_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_weight_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    impression_time_min: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    impression_color: Mapped[str | None] = mapped_column(String(100), nullable=True)
    impression_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
```

Register it in **all four**:

1. `backend/app/models/__init__.py` — `from backend.app.models.aito_task import AitoTask` (alphabetically after the `aito_project` import).
2. `backend/app/models/__init__.py` — add `"AitoTask"` to `__all__`.
3. `backend/app/core/database.py`, in `init_db()`'s import list — `aito_task,` after `aito_project,`.
4. `backend/tests/conftest.py`, in its import list — `aito_task,` in the same position.

- [ ] **Step 4: Run the model test**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_tasks_model.py -v`
Expected: PASS. A `no such table` failure means one of the four registrations is missing.

- [ ] **Step 5: Full backend run and commit**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/ -q && ruff check backend/`

```bash
git add backend/app/models/aito_task.py backend/app/models/__init__.py backend/app/core/database.py backend/tests/conftest.py backend/tests/unit/test_aito_tasks_model.py
git commit -m "feat(aito): aito_tasks table for project tasks and their services"
```

---

### Task 4: Task DTOs and creation with the project

**Files:**
- Modify: `backend/app/schemas/aito.py`, `backend/app/api/routes/aito.py`, `frontend/src/api/client.ts`
- Test: `backend/tests/unit/test_aito_routes.py`

**Interfaces:**
- Produces: `AitoTaskCreate`, `AitoTaskUpdate`, `AitoTaskResponse`; `AitoProjectCreate.tasks: list[AitoTaskCreate]`; TS `AitoTask`, `AitoTaskCreate`, `AitoTaskUpdate`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/unit/test_aito_routes.py`:

```python
def _task(**overrides):
    payload = {"title": "Boîtier", "scan_cost": 4000.0}
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_create_project_with_tasks_creates_them_in_order(async_client):
    r = await _create(
        async_client,
        tasks=[_task(title="Un"), _task(title="Deux", scan_cost=None, usinage_cost=12000.0)],
    )
    assert r.status_code == 201
    project_id = r.json()["id"]

    tasks = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()
    assert [t["title"] for t in tasks] == ["Un", "Deux"]
    assert [t["position"] for t in tasks] == [0, 1]
    assert tasks[1]["scan_cost"] is None
    assert tasks[1]["usinage_cost"] == 12000.0


@pytest.mark.asyncio
async def test_create_project_without_tasks_is_still_valid(async_client):
    r = await _create(async_client)
    assert r.status_code == 201
    assert (await async_client.get(f"/api/v1/aito/{r.json()['id']}/tasks")).json() == []


@pytest.mark.asyncio
async def test_project_list_does_not_include_tasks(async_client):
    """GET /aito/ drives the whole board and is refetched on every WebSocket
    invalidation; loading every task of every card would bloat it."""
    await _create(async_client, tasks=[_task()])
    body = (await async_client.get("/api/v1/aito/")).json()
    assert "tasks" not in body[0]


@pytest.mark.asyncio
async def test_create_project_rejects_a_negative_cost(async_client):
    r = await _create(async_client, tasks=[_task(scan_cost=-1)])
    assert r.status_code == 422
```

- [ ] **Step 2: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v -k "task"`
Expected: FAIL — 404 on the tasks endpoint.

- [ ] **Step 3: Add the DTOs**

In `backend/app/schemas/aito.py`:

```python
class AitoTaskBase(BaseModel):
    """A NULL cost means the service is disabled; 0 stays meaningful as free."""

    title: str | None = Field(default=None, max_length=200)
    description: str | None = None
    scan_cost: float | None = Field(default=None, ge=0)
    modelisation_cost: float | None = Field(default=None, ge=0)
    usinage_cost: float | None = Field(default=None, ge=0)
    impression_printer_id: int | None = None
    impression_filament_id: int | None = None
    impression_weight_g: float | None = Field(default=None, ge=0)
    impression_time_min: int | None = Field(default=None, ge=0)
    impression_quantity: int | None = Field(default=None, ge=1)
    impression_color: str | None = Field(default=None, max_length=100)
    impression_cost: float | None = Field(default=None, ge=0)


class AitoTaskCreate(AitoTaskBase):
    pass


class AitoTaskUpdate(AitoTaskBase):
    """Only keys present in the body are written — an omitted key is left alone,
    an explicit null clears the field. That is what lets one service be
    disabled without disturbing its siblings."""


class AitoTaskResponse(AitoTaskBase):
    id: int
    project_id: int
    position: int
    created_at: datetime
    updated_at: datetime
```

and add to `AitoProjectCreate`:

```python
    tasks: list[AitoTaskCreate] = Field(default_factory=list)
```

`AitoProjectResponse` is **not** given a `tasks` field — see the test above.

- [ ] **Step 4: Create the tasks with the project**

In `backend/app/api/routes/aito.py`, extend the imports —
`from backend.app.models.aito_task import AitoTask`, and add `AitoTaskCreate`,
`AitoTaskResponse` and `AitoTaskUpdate` to the existing
`from backend.app.schemas.aito import (...)` block — then add a mapper:

```python
def _task_to_response(t: AitoTask) -> AitoTaskResponse:
    return AitoTaskResponse(
        id=t.id,
        project_id=t.project_id,
        position=t.position,
        title=t.title,
        description=t.description,
        scan_cost=t.scan_cost,
        modelisation_cost=t.modelisation_cost,
        usinage_cost=t.usinage_cost,
        impression_printer_id=t.impression_printer_id,
        impression_filament_id=t.impression_filament_id,
        impression_weight_g=t.impression_weight_g,
        impression_time_min=t.impression_time_min,
        impression_quantity=t.impression_quantity,
        impression_color=t.impression_color,
        impression_cost=t.impression_cost,
        created_at=t.created_at,
        updated_at=t.updated_at,
    )
```

and in `create_project`, after `db.add(project)`, before the commit:

```python
    # Flush so the project has an id the tasks can reference; one commit still
    # covers both, so a failure creates neither.
    await db.flush()
    for position, task_payload in enumerate(payload.tasks):
        db.add(AitoTask(project_id=project.id, position=position, **task_payload.model_dump()))
```

- [ ] **Step 5: Add the list endpoint**

```python
@router.get("/{project_id}/tasks", response_model=list[AitoTaskResponse])
async def list_tasks(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    stmt = select(AitoTask).where(AitoTask.project_id == project_id).order_by(AitoTask.position, AitoTask.id)
    return [_task_to_response(t) for t in (await db.execute(stmt)).scalars().all()]
```

- [ ] **Step 6: Run the backend tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v && ruff check backend/`
Expected: PASS.

- [ ] **Step 7: Add the TypeScript types**

In `frontend/src/api/client.ts`, beside the Aito types:

```ts
export interface AitoTask {
  id: number;
  project_id: number;
  position: number;
  title: string | null;
  description: string | null;
  scan_cost: number | null;
  modelisation_cost: number | null;
  usinage_cost: number | null;
  impression_printer_id: number | null;
  impression_filament_id: number | null;
  impression_weight_g: number | null;
  impression_time_min: number | null;
  impression_quantity: number | null;
  impression_color: string | null;
  impression_cost: number | null;
  created_at: string;
  updated_at: string;
}

export type AitoTaskCreate = Omit<AitoTask, 'id' | 'project_id' | 'position' | 'created_at' | 'updated_at'>;
export type AitoTaskUpdate = Partial<AitoTaskCreate>;
```

add `tasks?: AitoTaskCreate[]` to `createAitoProject`'s parameter type, and:

```ts
  getAitoTasks: (projectId: number) => request<AitoTask[]>(`/aito/${projectId}/tasks`),
```

- [ ] **Step 8: Verify and commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json && cd ..`

```bash
git add backend/app/schemas/aito.py backend/app/api/routes/aito.py backend/tests/unit/test_aito_routes.py frontend/src/api/client.ts
git commit -m "feat(aito): create tasks with a project and list them"
```

---

### Task 5: Task CRUD for the detail panel

**Files:**
- Modify: `backend/app/api/routes/aito.py`, `frontend/src/api/client.ts`
- Test: `backend/tests/unit/test_aito_routes.py`

**Interfaces:** produces `POST /aito/{project_id}/tasks`, `PATCH /aito/tasks/{task_id}`, `DELETE /aito/tasks/{task_id}`; TS `api.createAitoTask`, `api.updateAitoTask`, `api.deleteAitoTask`.

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.asyncio
async def test_add_task_appends_at_the_end(async_client):
    project_id = (await _create(async_client, tasks=[_task(title="Un")])).json()["id"]
    r = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json=_task(title="Deux"))
    assert r.status_code == 201
    assert r.json()["position"] == 1


@pytest.mark.asyncio
async def test_patch_task_writes_clears_and_leaves_alone(async_client):
    project_id = (await _create(async_client, tasks=[_task(scan_cost=4000.0)])).json()["id"]
    task_id = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()[0]["id"]

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"usinage_cost": 12000.0})
    assert r.json()["usinage_cost"] == 12000.0
    assert r.json()["scan_cost"] == 4000.0  # untouched sibling

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_cost": None})
    assert r.json()["scan_cost"] is None      # explicit null disables the service
    assert r.json()["usinage_cost"] == 12000.0

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"title": "Autre"})
    assert r.json()["usinage_cost"] == 12000.0  # omitted key left alone


@pytest.mark.asyncio
async def test_delete_task_removes_only_that_task(async_client):
    project_id = (await _create(async_client, tasks=[_task(title="Un"), _task(title="Deux")])).json()["id"]
    tasks = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()

    assert (await async_client.delete(f"/api/v1/aito/tasks/{tasks[0]['id']}")).status_code == 204
    remaining = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()
    assert [t["title"] for t in remaining] == ["Deux"]


@pytest.mark.asyncio
async def test_task_endpoints_404_on_unknown_ids(async_client):
    assert (await async_client.patch("/api/v1/aito/tasks/9999", json={"title": "x"})).status_code == 404
    assert (await async_client.delete("/api/v1/aito/tasks/9999")).status_code == 404
    assert (await async_client.post("/api/v1/aito/9999/tasks", json=_task())).status_code == 404


@pytest.mark.asyncio
async def test_soft_deleting_a_project_keeps_its_tasks(async_client):
    project_id = (await _create(async_client, tasks=[_task()])).json()["id"]
    await async_client.delete(f"/api/v1/aito/{project_id}")
    await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert len((await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()) == 1
```

- [ ] **Step 2: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v -k task`
Expected: FAIL — 405 / 404.

- [ ] **Step 3: Add the endpoints**

```python
async def _get_task_or_404(db: AsyncSession, task_id: int) -> AitoTask:
    task = (await db.execute(select(AitoTask).where(AitoTask.id == task_id))).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.post("/{project_id}/tasks", response_model=AitoTaskResponse, status_code=201)
async def add_task(
    project_id: int,
    payload: AitoTaskCreate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_CREATE),
):
    project = (
        await db.execute(select(AitoProject).where(AitoProject.id == project_id))
    ).scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    highest = await db.scalar(select(func.max(AitoTask.position)).where(AitoTask.project_id == project_id))
    task = AitoTask(project_id=project_id, position=(highest + 1) if highest is not None else 0,
                    **payload.model_dump())
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return _task_to_response(task)


@router.patch("/tasks/{task_id}", response_model=AitoTaskResponse)
async def update_task(
    task_id: int,
    payload: AitoTaskUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_UPDATE),
):
    """Only fields present in the body are written, so an omitted key is left
    alone and an explicit null disables that service."""
    task = await _get_task_or_404(db, task_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(task, key, value)
    await db.commit()
    await db.refresh(task)
    return _task_to_response(task)


@router.delete("/tasks/{task_id}", status_code=204)
async def delete_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_DELETE),
):
    """Hard delete, unlike projects: tasks need no stable visible number, and
    hold-to-remove is already a deliberate gesture."""
    task = await _get_task_or_404(db, task_id)
    await db.delete(task)
    await db.commit()
```

**On route collisions:** these coexist safely with the existing
`PATCH /aito/{project_id}` and `PATCH /aito/{project_id}/move` because the paths
differ in segment count and in their literal last segment — `/aito/tasks/9999`
cannot match either. The `test_task_endpoints_404_on_unknown_ids` test is what
proves it: a **422** instead of a 404 there would mean a `/{project_id}` route
is capturing `tasks` as an id, and the new routes need declaring earlier.

- [ ] **Step 4: Run and add the API client methods**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/ -q && ruff check backend/`

```ts
  createAitoTask: (projectId: number, data: AitoTaskCreate) =>
    request<AitoTask>(`/aito/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
  updateAitoTask: (taskId: number, data: AitoTaskUpdate) =>
    request<AitoTask>(`/aito/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAitoTask: (taskId: number) =>
    request<void>(`/aito/tasks/${taskId}`, { method: 'DELETE' }),
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/routes/aito.py backend/tests/unit/test_aito_routes.py frontend/src/api/client.ts
git commit -m "feat(aito): task CRUD for editing from the detail panel"
```

---

### Task 6: `DurationInput` and `ImpressionFields`

**Files:**
- Create: `frontend/src/components/aito/DurationInput.tsx`, `frontend/src/components/aito/ImpressionFields.tsx`

**Interfaces:**
- Consumes: `splitMinutes`, `joinMinutes`, `computeImpressionCost`, `ImpressionDraft` (Task 2); `SearchableSelect`; `inputCls`, `labelCls`; `Money` from the calculator's shared components; `api.getCalculatorFilaments/Printers/Defaults`.
- Produces:

```ts
export interface DurationInputProps {
  minutes: number | null;
  onChange: (minutes: number | null) => void;
  id?: string;
}
export function DurationInput(props: DurationInputProps): JSX.Element;

export interface ImpressionFieldsProps {
  value: ImpressionDraft;
  onChange: (next: ImpressionDraft) => void;
  /** The recomputed total, hoisted so the parent can store it. */
  onCostChange: (total: number | null) => void;
}
export function ImpressionFields(props: ImpressionFieldsProps): JSX.Element;
```

- [ ] **Step 1: Create `DurationInput`**

Three numeric inputs emitting one total. Emits `null` when all three are empty, so an untouched field leaves the service disabled rather than setting it to zero minutes.

```tsx
import { useTranslation } from 'react-i18next';
import { splitMinutes, joinMinutes } from '../../utils/taskDraft';
import { inputCls } from '../formStyles';

export interface DurationInputProps {
  minutes: number | null;
  onChange: (minutes: number | null) => void;
  id?: string;
}

/** Days / hours / minutes in, one integer of minutes out. The split is a UI
 *  concern only — storing three columns would invite "90 minutes" and "1h30"
 *  disagreeing. */
const UNIT_KEYS = {
  days: 'calculator.durationDaysShort',
  hours: 'calculator.durationHoursShort',
  minutes: 'calculator.durationMinutesShort',
} as const;

export function DurationInput({ minutes, onChange, id }: DurationInputProps) {
  const { t } = useTranslation();
  const parts = splitMinutes(minutes ?? 0);

  const set = (key: 'days' | 'hours' | 'minutes', raw: string) => {
    const next = { ...parts, [key]: raw === '' ? 0 : Math.max(0, Math.floor(Number(raw) || 0)) };
    const total = joinMinutes(next);
    // All-empty means "not set", which keeps the service disabled rather than
    // pinning it to zero minutes.
    onChange(raw === '' && total === 0 ? null : total);
  };

  return (
    <div className="flex items-center gap-2">
      {(['days', 'hours', 'minutes'] as const).map((key, index) => (
        <div key={key} className="flex items-center gap-1">
          <input
            id={index === 0 ? id : undefined}
            type="number"
            min={0}
            inputMode="numeric"
            value={minutes === null ? '' : parts[key]}
            onChange={(e) => set(key, e.target.value)}
            className={`${inputCls} w-16 text-right`}
          />
          {/* Reuses the calculator's existing per-locale duration suffixes
              rather than duplicating them under aito.* — they are already
              translated in all 12 files and already used for this exact
              purpose by CalculatorInputsCard. */}
          <span className="text-xs text-bambu-gray">{t(UNIT_KEYS[key])}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create `ImpressionFields`**

It loads filaments, printers and defaults with TanStack Query (`staleTime: 60_000`), renders the six inputs, computes the cost live, and reports the total up via `onCostChange`.

Key requirements:
- Printer and material use `SearchableSelect` over `api.getCalculatorPrinters()` / `getCalculatorFilaments()`, keyed by `String(id)`.
- When either list is empty, render `t('aito.noPrintersConfigured')` / `t('aito.noFilamentsConfigured')` instead of an empty dropdown, with a link to `/calculator`.
- Weight is numeric; colour is free text; quantity is numeric with a minimum of 1 defaulting to 1.
- The breakdown shows filament, depreciation, energy, repairs, risk (prototype + failures), ads, margin and the total, using `Money` so it matches the calculator's formatting.
- `onCostChange` fires in a `useEffect` keyed on the computed result, passing `result?.total_ttc_qty ?? null`. It must **not** be called during render.

`CalculatorFilament` and `CalculatorPrinter` are supersets of `PricingFilament` / `PricingPrinter`, so they can be passed straight through — no mapping layer.

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build && cd ..`
Expected: no errors. These components are covered by Task 7's tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/aito/DurationInput.tsx frontend/src/components/aito/ImpressionFields.tsx
git commit -m "feat(aito): duration input and Impression3D fields with a live cost"
```

---

### Task 7: `TaskRow` and `TaskEditor`

**Files:**
- Create: `frontend/src/components/aito/TaskRow.tsx`, `frontend/src/components/aito/TaskEditor.tsx`, `frontend/src/__tests__/components/TaskEditor.test.tsx`

**Interfaces:**

```ts
export interface TaskRowProps {
  task: TaskDraft;
  index: number;
  onChange: (next: TaskDraft) => void;
  onRemove: () => void;
}
export function TaskRow(props: TaskRowProps): JSX.Element;

export interface TaskEditorProps {
  value: TaskDraft[];
  onChange: (next: TaskDraft[]) => void;
  onRemove: (index: number) => void;
}
export function TaskEditor(props: TaskEditorProps): JSX.Element;
```

`TaskEditor` is **presentational** — it knows nothing about **persistence**. No
`useMutation`, no POST/PATCH/DELETE: writes belong to the two callers, which is
what lets the create modal hold an array in state while the detail panel wires
each change to a PATCH.

Read-only queries for *display* data are fine and expected. `ImpressionFields`
must fetch filaments, printers and calculator defaults — they are its data
source — so the subtree already requires a QueryClient; a cached settings read
for the currency symbol adds no new coupling. The rule is about who owns
writes, not about avoiding `api` entirely.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/__tests__/components/TaskEditor.test.tsx` covering:
- "Add task" appends a draft with all four services empty (`onChange` called with a one-longer array whose last entry equals `emptyTaskDraft()`).
- Typing a Scan3D cost emits a draft with `scanCost` set; clearing it emits `null`, not `0`.
- A task with an empty title renders `Task 1`; with a title, renders the title.
- The task total reflects the enabled services.
- Holding the remove button for 2s calls `onRemove` with that index; a short press does not.
- `onChange` receives a **new** array — the editor never mutates its input (assert `result !== value`).

Mock the three calculator queries with MSW so `ImpressionFields` renders.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/TaskEditor.test.tsx && cd ..`
Expected: FAIL — cannot resolve the components.

- [ ] **Step 3: Create `TaskRow`**

One task: title input, description textarea, the four service blocks, the task total, and `DeleteHoldButton`. Scan3D / Modelisation3D / Usinage are each one numeric cost input where empty emits `null`. Impression3D renders `ImpressionFields` and stores the reported total into `impressionCost`.

The fallback name is `t('aito.taskFallbackName', { n: index + 1 })` when `title.trim()` is empty.

- [ ] **Step 4: Create `TaskEditor`**

The heading, the list of `TaskRow`s, "+ Add task", and the project total. It maps changes back into a **new** array — never mutating `value`.

- [ ] **Step 5: Run the tests, then prove one can fail**

Run: `cd frontend && npx vitest run src/__tests__/components/TaskEditor.test.tsx && cd ..`

Then make the clear-a-cost path emit `0` instead of `null`, confirm the "clearing emits null, not 0" test FAILS, restore, and confirm green. Report both outputs — `null` vs `0` is the difference between a disabled service and a free one, and nothing else in the stack distinguishes them.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/aito/TaskRow.tsx frontend/src/components/aito/TaskEditor.tsx frontend/src/__tests__/components/TaskEditor.test.tsx
git commit -m "feat(aito): task row and task editor"
```

---

### Task 8: Wire the editor into the create modal

**Files:**
- Modify: `frontend/src/components/aito/NewProjectModal.tsx`, `frontend/src/pages/AitoPage.tsx`
- Test: `frontend/src/__tests__/components/NewProjectModal.test.tsx`

**Interfaces:** `NewProjectModal`'s `onCreate` becomes `(description: string, draft: ClientDraft, tasks: TaskDraft[]) => void`.

- [ ] **Step 1: Write the failing test**

In `NewProjectModal.test.tsx`, add: adding a task and filling a Scan3D cost results in `onCreate` being called with a `tasks` array carrying that cost. Mock the calculator queries.

- [ ] **Step 2: Hold the array in the modal**

`const [tasks, setTasks] = useState<TaskDraft[]>([])`, render `<TaskEditor>` under the description field, and pass `tasks` to `onCreate`. Cancel still means cancel — nothing is written until submit.

- [ ] **Step 3: Send them with the project**

In `AitoPage.tsx`, widen the create mutation's variables to carry `tasks`, and map each `TaskDraft` to the API shape in `mutationFn`:

```tsx
        tasks: tasks.map((t) => ({
          title: t.title.trim() || null,
          description: t.description.trim() || null,
          scan_cost: t.scanCost,
          modelisation_cost: t.modelisationCost,
          usinage_cost: t.usinageCost,
          impression_printer_id: t.impression.printerId,
          impression_filament_id: t.impression.filamentId,
          impression_weight_g: t.impression.weightG,
          impression_time_min: t.impression.timeMin,
          impression_quantity: t.impression.quantity,
          impression_color: t.impression.color.trim() || null,
          impression_cost: t.impressionCost,
        })),
```

- [ ] **Step 4: Verify and commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build && cd .. && ./test_frontend.sh`

```bash
git add frontend/src/components/aito/NewProjectModal.tsx frontend/src/pages/AitoPage.tsx frontend/src/__tests__/components/NewProjectModal.test.tsx
git commit -m "feat(aito): build tasks in the create-project modal"
```

---

### Task 9: Wire the editor into the detail panel

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx`
- Test: `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `ProjectDetailPanel.test.tsx`, with MSW mocking `GET /aito/{id}/tasks` plus the calculator queries:
- The panel fetches and renders the project's tasks on open.
- Editing a service cost issues `PATCH /aito/tasks/{id}` with only that field in the body.
- "Add task" issues `POST /aito/{project_id}/tasks`.
- Hold-to-remove issues `DELETE /aito/tasks/{id}`.
- A failed PATCH shows the existing `aito.saveFailed` toast and does not lose the panel's other state.

Assert on captured request bodies, not call counts.

- [ ] **Step 2: Wire it**

Fetch with `useQuery(['aito-tasks', project.id], () => api.getAitoTasks(project.id))`. Convert rows to `TaskDraft` on load and back on write. Each `TaskEditor` change diffs against the loaded row and PATCHes only the changed fields; add and remove call their endpoints and invalidate `['aito-tasks', project.id]`.

- [ ] **Step 3: Verify and commit**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.app.json && npm run build && cd .. && ./test_frontend.sh`, plus `./venv/bin/python3 -m pytest backend/tests/unit/ -q`.

```bash
git add frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/__tests__/components/ProjectDetailPanel.test.tsx
git commit -m "feat(aito): edit project tasks from the detail panel"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| i18n incl. the service-name allowlist | 1 |
| Pure helpers, cost composition, zeroed flats, `total_ttc_qty` | 2 |
| `aito_tasks` table, four registration points | 3 |
| DTOs, create-with-tasks, tasks excluded from `GET /aito/` | 4 |
| Task CRUD, PATCH three-way semantics, hard delete | 5 |
| Duration input, six Impression3D inputs, live breakdown | 6 |
| `TaskRow` / presentational `TaskEditor` | 7 |
| Create-modal wiring | 8 |
| Detail-panel wiring | 9 |

**Type consistency:** `TaskDraft` is the single client-side shape; the API shape is `AitoTask` and conversion happens only at the two wiring points (Tasks 8 and 9). `null` means "service disabled" at every layer — Pydantic, TypeScript and the draft agree. `impression_quantity` is `int | None` on the wire and `number` (never null, minimum 1) on the draft, because the editor always has a value.

**Deliberately out of scope:** reordering tasks; a project total on the board card; applying the per-job flats once at project level; quantity/modelling/prep/post as calculator-style per-task inputs; exporting a quote to Zoho.
