# Aito Card Task Summary and Wide Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each Aito project's task summary (service badges, count, total) on its board card, and rebuild the create modal and detail panel as wide two-column surfaces so they stop running out of vertical room.

**Architecture:** The board response gains three aggregate fields produced by one grouped SQL query over `aito_tasks`, threaded through every endpoint that returns an `AitoProjectResponse`. The card renders them. Both dialog surfaces go from `max-w-md` to `max-w-5xl` with a two-column body that collapses to one column below `lg:`, and `ImpressionFields` splits so its cost breakdown sits beside its inputs instead of below them.

**Tech Stack:** FastAPI, SQLAlchemy 2.0 (async, aiosqlite), Pydantic v2, pytest; React 19, TanStack Query, Tailwind CSS 4, Vitest + Testing Library + MSW, react-i18next.

**Spec:** `docs/superpowers/specs/2026-07-28-aito-card-task-summary-and-wide-layout-design.md`

## Global Constraints

- **`NULL` means the service is disabled; `0` means it is free.** Service membership is always tested with `IS NOT NULL` / `!== null`, never `> 0`. This invariant is load-bearing across the whole task feature.
- **`frontend/src/utils/pricing.ts` must not be modified.**
- **Never stage `static/index.html`** — it is build output owned by the repo owner.
- **Never stage `frontend/src/__tests__/components/ViewTransitionWiring.test.tsx`** — untracked, owned by the repo owner.
- **Do not reformat the six pre-existing `ruff format` failures**: `backend/app/api/routes/camera.py`, `backend/app/api/routes/library.py`, `backend/tests/unit/test_camera_api.py`, `backend/tests/unit/test_library_file_history_api.py`, `backend/tests/unit/test_aito_project_model.py`, `backend/tests/unit/test_camera_chamber_stream.py`. `./test_backend.sh` is already red on these; that is the baseline, not a regression you caused.
- Python line length 120, double quotes, Ruff (E, W, F, I, B, C4, UP, ARG, SIM), Python 3.10 target — **no `datetime.UTC`**.
- Response field names are exactly `task_count`, `tasks_total`, `task_services`. Not `task_total` — the frontend already has `taskTotal` for a *single* task and two names one letter apart for different scopes is a bug waiting to be written.
- `task_services` values are exactly `"scan"`, `"modelisation"`, `"impression"`, `"usinage"`, always emitted in **that order**.
- **`npx tsc` type-checks nothing.** `frontend/tsconfig.json` is `{"files": [], "references": [...]}`, and `tsconfig.app.json` has `"exclude": ["src/__tests__"]`. The real gates are `cd frontend && npm run build` (app code) and `npm run test:run` (tests, at runtime only). Test files are **never** type-checked by anything — do not rely on the compiler to catch a stale fixture.

---

### Task 1: Backend task-summary aggregate

**Files:**
- Modify: `backend/app/schemas/aito.py:90-103` (`AitoProjectResponse`)
- Modify: `backend/app/api/routes/aito.py` (add helpers; update `_to_response` and its seven call sites)
- Test: `backend/tests/unit/test_aito_routes.py`

**Interfaces:**
- Consumes: `AitoTask` from `backend.app.models.aito_task` (already imported in the routes module).
- Produces: `AitoProjectResponse` with `task_count: int`, `tasks_total: float`, `task_services: list[str]`. Task 2 consumes this shape from the frontend.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/unit/test_aito_routes.py`:

```python
@pytest.mark.asyncio
async def test_project_list_summarises_tasks(async_client):
    r = await _create(
        async_client,
        tasks=[
            _task(title="Un", scan_cost=4000.0),
            _task(title="Deux", scan_cost=None, usinage_cost=12000.0),
        ],
    )
    project_id = r.json()["id"]

    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == project_id)
    assert card["task_count"] == 2
    assert card["tasks_total"] == 16000.0
    assert card["task_services"] == ["scan", "usinage"]


@pytest.mark.asyncio
async def test_project_without_tasks_summarises_to_zero(async_client):
    r = await _create(async_client)
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_count"] == 0
    assert card["tasks_total"] == 0.0
    assert card["task_services"] == []


@pytest.mark.asyncio
async def test_a_free_service_still_counts_as_enabled(async_client):
    """0 is a price, NULL is a disabled service. A service quoted at zero must
    still appear in task_services — an aggregate testing `> 0` instead of
    IS NOT NULL would silently drop it, and the total would look identical."""
    r = await _create(async_client, tasks=[_task(scan_cost=0.0)])
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_services"] == ["scan"]
    assert card["tasks_total"] == 0.0
    assert card["task_count"] == 1


@pytest.mark.asyncio
async def test_task_services_use_canonical_order_not_insertion_order(async_client):
    r = await _create(
        async_client,
        tasks=[
            _task(title="Un", scan_cost=None, usinage_cost=100.0),
            _task(title="Deux", scan_cost=None, modelisation_cost=200.0),
            _task(title="Trois", scan_cost=1.0),
        ],
    )
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_services"] == ["scan", "modelisation", "usinage"]


@pytest.mark.asyncio
async def test_tasks_total_sums_exactly_the_four_cost_columns(async_client):
    """Pins the arithmetic. This mirrors `taskTotal` in
    frontend/src/utils/taskDraft.ts; the two are in different languages and
    cannot share code, so a change to one must be made in the other."""
    r = await _create(
        async_client,
        tasks=[
            _task(
                scan_cost=1.0,
                modelisation_cost=20.0,
                usinage_cost=300.0,
                impression_cost=4000.0,
            )
        ],
    )
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["tasks_total"] == 4321.0


@pytest.mark.asyncio
async def test_patch_response_carries_the_task_summary(async_client):
    """The detail panel writes the PATCH response straight into the board cache
    (setQueryData replaces the row), so a response missing the aggregate would
    blank the card's badges until the next fetch."""
    r = await _create(async_client, tasks=[_task(scan_cost=4000.0)])
    project_id = r.json()["id"]
    patched = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Nouveau"})
    assert patched.status_code == 200
    assert patched.json()["task_count"] == 1
    assert patched.json()["tasks_total"] == 4000.0
    assert patched.json()["task_services"] == ["scan"]


@pytest.mark.asyncio
async def test_create_response_carries_the_task_summary(async_client):
    r = await _create(async_client, tasks=[_task(title="Un"), _task(title="Deux")])
    assert r.status_code == 201
    assert r.json()["task_count"] == 2


@pytest.mark.asyncio
async def test_move_and_restore_responses_carry_the_task_summary(async_client):
    r = await _create(async_client, tasks=[_task(scan_cost=4000.0)])
    project_id = r.json()["id"]

    moved = await async_client.patch(f"/api/v1/aito/{project_id}/move", json={"column": "print", "position": 0})
    assert moved.json()["task_count"] == 1

    await async_client.delete(f"/api/v1/aito/{project_id}")
    restored = await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert restored.json()["task_count"] == 1
```

And a direct unit test of the helper, in the same file:

```python
@pytest.mark.asyncio
async def test_task_summaries_handles_many_projects_and_an_empty_list(db_session):
    from backend.app.api.routes.aito import _task_summaries

    assert await _task_summaries(db_session, []) == {}

    db_session.add_all(
        [
            AitoTask(project_id=1, position=0, scan_cost=10.0),
            AitoTask(project_id=1, position=1, usinage_cost=5.0),
            AitoTask(project_id=2, position=0, modelisation_cost=7.0),
        ]
    )
    await db_session.commit()

    summaries = await _task_summaries(db_session, [1, 2, 3])
    assert summaries[1].count == 2
    assert summaries[1].total == 15.0
    assert summaries[1].services == ("scan", "usinage")
    assert summaries[2].services == ("modelisation",)
    # A project with no tasks is simply absent — callers fall back to the empty
    # summary rather than paying for a row per task-free card.
    assert 3 not in summaries
```

Add the import this test needs at the top of the file, beside the existing `AitoProject` import:

```python
from backend.app.models.aito_task import AitoTask
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v -k "summar or free_service or canonical or four_cost or carries"`

Expected: FAIL — `KeyError: 'task_count'` on the endpoint tests, `ImportError: cannot import name '_task_summaries'` on the helper test.

- [ ] **Step 3: Add the response fields**

In `backend/app/schemas/aito.py`, inside `AitoProjectResponse`, between `client_is_company` and `created_at`:

```python
    client_is_company: bool | None
    # Aggregates over the project's tasks, so the board card can show a summary
    # without GET /aito/ shipping every task row. Required, never defaulted:
    # see _to_response in the routes module.
    task_count: int
    tasks_total: float
    task_services: list[str]
    created_at: datetime
```

- [ ] **Step 4: Add the aggregate helpers**

In `backend/app/api/routes/aito.py`, add `case` to the SQLAlchemy import and `dataclass` at the top:

```python
from dataclasses import dataclass

from sqlalchemy import case, func, select
```

Then, immediately above `_to_response`:

```python
# Canonical order for `task_services`, fixed here so the card's badge row is
# stable across refetches regardless of the order tasks were created in.
_SERVICE_COLUMNS = (
    ("scan", AitoTask.scan_cost),
    ("modelisation", AitoTask.modelisation_cost),
    ("impression", AitoTask.impression_cost),
    ("usinage", AitoTask.usinage_cost),
)


@dataclass(frozen=True)
class _TaskSummary:
    count: int = 0
    total: float = 0.0
    services: tuple[str, ...] = ()


_EMPTY_SUMMARY = _TaskSummary()


async def _task_summaries(db: AsyncSession, project_ids: list[int]) -> dict[int, _TaskSummary]:
    """Task count, total and enabled-service set per project, in ONE query.

    Membership is tested with IS NOT NULL, never `> 0`: NULL means the service
    is disabled and 0 means it is free, and a service quoted at zero must still
    show its badge.

    The SUM() below mirrors `taskTotal` in frontend/src/utils/taskDraft.ts. The
    two are in different languages and cannot share code — if the definition of
    a task's total changes, it must be changed in both places.

    Projects with no tasks are absent from the result; callers fall back to
    ``_EMPTY_SUMMARY``.
    """
    if not project_ids:
        return {}
    stmt = (
        select(
            AitoTask.project_id,
            func.count().label("n"),
            func.sum(
                func.coalesce(AitoTask.scan_cost, 0.0)
                + func.coalesce(AitoTask.modelisation_cost, 0.0)
                + func.coalesce(AitoTask.usinage_cost, 0.0)
                + func.coalesce(AitoTask.impression_cost, 0.0)
            ).label("total"),
            *[
                func.max(case((column.is_not(None), 1), else_=0)).label(f"svc_{name}")
                for name, column in _SERVICE_COLUMNS
            ],
        )
        .where(AitoTask.project_id.in_(project_ids))
        .group_by(AitoTask.project_id)
    )
    return {
        row.project_id: _TaskSummary(
            count=row.n,
            total=float(row.total or 0.0),
            services=tuple(name for name, _ in _SERVICE_COLUMNS if getattr(row, f"svc_{name}")),
        )
        for row in (await db.execute(stmt)).all()
    }


async def _one_summary(db: AsyncSession, project_id: int) -> _TaskSummary:
    """Summary for a single project, for the endpoints that return one card."""
    return (await _task_summaries(db, [project_id])).get(project_id, _EMPTY_SUMMARY)
```

Note the labels: `n`, not `count` — a SQLAlchemy `Row` is tuple-like, so `row.count` resolves to `tuple.count` and would return a bound method instead of the aggregate.

- [ ] **Step 5: Thread the summary through `_to_response` and its seven call sites**

Change the signature and body of `_to_response`:

```python
def _to_response(p: AitoProject, summary: _TaskSummary) -> AitoProjectResponse:
    """`summary` is required, never defaulted. The detail panel writes PATCH
    responses straight into the board cache with setQueryData, replacing the
    row — so an endpoint that quietly returned zeros would blank a card's
    badges and nothing would fail. Requiring it makes every call site state
    its intent."""
    return AitoProjectResponse(
        id=p.id,
        description=p.description,
        column=p.board_column,
        position=p.position,
        status=p.status,
        client_id=p.client_id,
        client_name=p.client_name,
        client_phone=p.client_phone,
        client_email=p.client_email,
        client_is_company=p.client_is_company,
        task_count=summary.count,
        tasks_total=summary.total,
        task_services=list(summary.services),
        created_at=p.created_at,
        updated_at=p.updated_at,
    )
```

`list_projects` — replace its `return` with:

```python
    projects = list((await db.execute(stmt)).scalars().all())
    summaries = await _task_summaries(db, [p.id for p in projects])
    return [_to_response(p, summaries.get(p.id, _EMPTY_SUMMARY)) for p in projects]
```

`list_trash` — the identical three lines, after its own `stmt`.

`create_project` — replace `return _to_response(project)` with:

```python
    return _to_response(project, await _one_summary(db, project.id))
```

`move_project`, `update_project`, `restore_project` — the same one-line change to each of their `return _to_response(project)` statements.

`import_legacy_projects` — replace its return with:

```python
    # Imported projects are task-free by construction: the legacy localStorage
    # board had no concept of tasks.
    return [_to_response(p, _EMPTY_SUMMARY) for p in created]
```

- [ ] **Step 6: Update the stale docstring on the existing exclusion test**

`test_project_list_does_not_include_tasks` still passes (none of the three new keys is named `tasks`), but its docstring now describes only half the position. Replace the docstring:

```python
async def test_project_list_does_not_include_tasks(async_client):
    """GET /aito/ drives the whole board and is refetched on every WebSocket
    invalidation; loading every task of every card would bloat it. The card's
    summary is served instead by three aggregate fields from one grouped query
    — see test_project_list_summarises_tasks."""
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py backend/tests/unit/test_aito_tasks_model.py -v`

Expected: PASS, all tests in both files.

- [ ] **Step 8: Prove the `IS NOT NULL` test can fail**

Temporarily change `column.is_not(None)` to `column > 0` in `_task_summaries` and re-run:

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_aito_routes.py -v -k free_service`

Expected: FAIL — `assert [] == ['scan']`. **Restore `is_not(None)` immediately afterwards** and re-run to confirm PASS. A test that cannot fail is not a test.

- [ ] **Step 9: Point the frontend half of the duplicated arithmetic back at this one**

The SQL `SUM(COALESCE(...))` and `taskTotal` in `frontend/src/utils/taskDraft.ts` compute the same figure in two languages and cannot share code. The backend docstring already names the frontend; the frontend must name the backend, or the cross-reference only works in one direction. Add to `taskTotal`'s docstring comment in `frontend/src/utils/taskDraft.ts`:

```ts
/** … existing description …
 *
 *  Mirrored by the SUM(COALESCE(...)) in `_task_summaries`
 *  (backend/app/api/routes/aito.py), which computes the same figure for the
 *  board card. The two are in different languages and cannot share code — if
 *  this definition changes, change that one too. */
```

Keep whatever the existing comment already says; append these lines to it rather than replacing it.

- [ ] **Step 10: Lint**

Run: `ruff check backend/app/api/routes/aito.py backend/app/schemas/aito.py backend/tests/unit/test_aito_routes.py && ruff format --check backend/app/api/routes/aito.py backend/app/schemas/aito.py backend/tests/unit/test_aito_routes.py`

Expected: clean. If `ruff format --check` objects, run `ruff format` on those three files only — they are not among the six pre-existing failures listed in Global Constraints.

- [ ] **Step 11: Commit**

```bash
git add backend/app/api/routes/aito.py backend/app/schemas/aito.py backend/tests/unit/test_aito_routes.py frontend/src/utils/taskDraft.ts
git commit -m "feat(aito): aggregate task count, total and services onto the board response"
```

---

### Task 2: Task summary on the board card

**Files:**
- Modify: `frontend/src/api/client.ts:3421-3434` (`AitoProject`)
- Modify: `frontend/src/components/aito/CardView.tsx`
- Modify: all 12 files in `frontend/src/i18n/locales/`
- Modify: `frontend/src/__tests__/components/AitoCardView.test.tsx`
- Modify: `frontend/src/__tests__/components/AitoBoardColumnDrag.test.tsx:67`
- Modify: `frontend/src/__tests__/utils/aitoBoard.test.ts:12`
- Modify: `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx:10`
- Modify: `frontend/src/__tests__/pages/AitoPage.test.tsx:13-17`
- Modify: `frontend/src/__tests__/pages/AitoPageClientSync.test.tsx`

**Interfaces:**
- Consumes: `task_count`, `tasks_total`, `task_services` from Task 1's `AitoProjectResponse`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/__tests__/components/AitoCardView.test.tsx`, inside the existing `describe('CardView', ...)`:

```tsx
  it('shows a badge per enabled service, the task count and the total', async () => {
    render(
      <CardView
        project={{ ...project, task_count: 2, tasks_total: 20200, task_services: ['modelisation', 'impression'] }}
        onExpand={vi.fn()}
      />,
    );
    expect(await screen.findByText('Modelisation3D')).toBeInTheDocument();
    expect(screen.getByText('Impression3D')).toBeInTheDocument();
    expect(screen.queryByText('Scan3D')).not.toBeInTheDocument();
    expect(screen.getByText(/2 tasks|2 tâches/i)).toBeInTheDocument();
    // Matched on the digits, not the whole formatted string: the currency and
    // separators come from formatMoney and the settings stub, and pinning them
    // here would make this a test of formatMoney.
    expect(screen.getByText(/20[,\s.]?200/)).toBeInTheDocument();
  });

  it('renders no summary row at all for a project with no tasks', () => {
    render(
      <CardView
        project={{ ...project, task_count: 0, tasks_total: 0, task_services: [] }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByText(/0 tasks|0 tâches/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Scan3D')).not.toBeInTheDocument();
    expect(screen.queryByText('Impression3D')).not.toBeInTheDocument();
  });

  it('keeps the summary inside the body button, so it opens the panel', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={{ ...project, task_count: 1, tasks_total: 4000, task_services: ['scan'] }}
        onExpand={onExpand}
      />,
    );
    await user.click(await screen.findByText('Scan3D'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoCardView.test.tsx`

Expected: FAIL — `Unable to find an element with the text: Modelisation3D`.

- [ ] **Step 3: Extend the `AitoProject` type**

In `frontend/src/api/client.ts`, inside `interface AitoProject`, between `client_is_company` and `created_at`:

```ts
  client_is_company: boolean | null;
  /** Aggregates over the project's tasks — see the Aito board response. The
   *  board never ships task rows themselves. */
  task_count: number;
  tasks_total: number;
  task_services: string[];
  created_at: string;
```

- [ ] **Step 4: Add the i18n key**

In each of the 12 files under `frontend/src/i18n/locales/`, add to the `aito` block, immediately after the existing `tasks:` key. English (`en.ts`):

```ts
    taskCount_one: '{{count}} task',
    taskCount_other: '{{count}} tasks',
```

French (`fr.ts`):

```ts
    taskCount_one: '{{count}} tâche',
    taskCount_other: '{{count}} tâches',
```

Translate genuinely for `de`, `es`, `it`, `ja`, `ko`, `pt-BR`, `ru`, `tr`, `zh-CN`, `zh-TW`. Locales without a plural distinction (`ja`, `ko`, `zh-CN`, `zh-TW`) use **only** `taskCount_other` — i18next resolves the `other` category for them, and adding an unused `_one` is dead weight. Locales with extra plural categories (`ru` has `_few` and `_many`; `pl`-style rules do not apply here) must carry every category their rule set produces — check the existing plural keys in that same file for the categories it already uses.

- [ ] **Step 5: Render the summary in `CardView`**

Add imports at the top of `frontend/src/components/aito/CardView.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Money } from '../calculator/shared';
```

Add above the `CardView` function:

```tsx
/** The four service ids the board response can return, mapped to the labels
 *  the task editor already uses. These are the shop's service names and are
 *  byte-identical in all twelve locales, so there is nothing new to translate.
 *  An unknown id falls back to itself rather than rendering blank, so a
 *  server-side addition shows up instead of disappearing. */
const SERVICE_LABEL_KEYS: Record<string, string> = {
  scan: 'aito.serviceScan3D',
  modelisation: 'aito.serviceModelisation3D',
  impression: 'aito.serviceImpression3D',
  usinage: 'aito.serviceUsinage',
};
```

Inside `CardView`, after the existing `const { t, i18n } = useTranslation();`:

```tsx
  // Same query key the task editor and the calculator page use for the
  // configured currency, so the card rides their cache instead of adding a
  // fetch per card.
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const currency = settings?.currency || 'USD';
```

Then, still inside `CardView` and above the `return`:

```tsx
  // Every element here is phrasing content (<span>, and Money renders a
  // <span>): this block is rendered INSIDE the body <button>, and a <button>
  // may not contain <div> or <p>. Keeping it inside the button is deliberate —
  // it makes the whole content area one target that opens the panel.
  const summary =
    project.task_count > 0 ? (
      <span className="mt-2 block">
        <span className="flex flex-wrap gap-1">
          {project.task_services.map((service) => (
            <span
              key={service}
              className="rounded px-1.5 py-0.5 text-[10px] leading-tight bg-bambu-dark-tertiary text-bambu-gray-light"
            >
              {SERVICE_LABEL_KEYS[service] ? t(SERVICE_LABEL_KEYS[service]) : service}
            </span>
          ))}
        </span>
        <span className="mt-1 flex items-baseline justify-between gap-2">
          <span className="text-xs text-bambu-gray">{t('aito.taskCount', { count: project.task_count })}</span>
          <Money currency={currency} value={project.tasks_total} className="text-xs font-medium text-bambu-green" />
        </span>
      </span>
    ) : null;
```

Render `{summary}` in **both** description branches — inside the `<button>` after the description `<span>`, and inside the non-interactive `<div>` after the description `<p>`. The DragOverlay clone takes the second branch and must show the same content, or the card visibly loses its badges the moment you pick it up.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoCardView.test.tsx`

Expected: PASS, including the three new tests.

- [ ] **Step 7: Update every `AitoProject` fixture and MSW handler**

**These will not fail the compiler** — `tsconfig.app.json` excludes `src/__tests__`, so nothing type-checks test files. They must be updated by hand, or the suite quietly stops exercising the shape the server actually returns.

Add `task_count: 0, tasks_total: 0, task_services: []` to each of these object literals:

- `frontend/src/__tests__/utils/aitoBoard.test.ts:12` — the `card()` factory. Note this fixture is also missing `client_email` and `client_is_company`; add those as `null` at the same time so the factory finally matches the interface.
- `frontend/src/__tests__/components/AitoCardView.test.tsx:8` — the shared `project`. The three new tests above override these per-test, so the shared default stays the empty summary.
- `frontend/src/__tests__/components/AitoBoardColumnDrag.test.tsx:67` — also missing `client_is_company`; add it as `null`.
- `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx:10`.
- `frontend/src/__tests__/pages/AitoPage.test.tsx:13-17` — the `project` object used by the `/api/v1/aito/` handler.
- `frontend/src/__tests__/pages/AitoPageClientSync.test.tsx` — every project literal returned by an MSW handler (4 sites; find them with `grep -n client_is_company`).

- [ ] **Step 8: Run the full frontend suite**

Run: `cd frontend && npm run test:run`

Expected: PASS. `PrintModal` tests are known to flake — if one fails, re-run that file alone before investigating.

- [ ] **Step 9: Build and lint**

Run: `cd frontend && npm run build && npm run lint`

Expected: both clean.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/components/aito/CardView.tsx frontend/src/i18n/locales frontend/src/__tests__/components/AitoCardView.test.tsx frontend/src/__tests__/components/AitoBoardColumnDrag.test.tsx frontend/src/__tests__/components/ProjectDetailPanel.test.tsx frontend/src/__tests__/utils/aitoBoard.test.ts frontend/src/__tests__/pages/AitoPage.test.tsx frontend/src/__tests__/pages/AitoPageClientSync.test.tsx
git commit -m "feat(aito): show service badges, task count and total on the board card"
```

---

### Task 3: Keep the card summary fresh from the detail panel

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx:142-152` (add/delete mutations) and around `:229-248` (the effects block)
- Test: `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx`

**Interfaces:**
- Consumes: the `['aito-projects']` query key used by `AitoPage`, and Task 1's summary-carrying PATCH response.
- Produces: nothing other tasks depend on.

**Why three different mechanisms:** adding or removing a task changes the count immediately and already invalidates its own query, so it invalidates the board too. Editing a task *field* PATCHes **per keystroke** — invalidating the board there would refetch the whole board on every character, which is indefensible — so it is deferred to panel close. Editing the description needs nothing at all, because Task 1 made the PATCH response carry the summary.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx`:

```tsx
  it('refreshes the board when a task is added and when one is removed', async () => {
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.post('/api/v1/aito/12/tasks', () =>
        HttpResponse.json({ ...taskFixture, id: 99 }, { status: 201 }),
      ),
      http.delete('/api/v1/aito/tasks/:id', () => new HttpResponse(null, { status: 204 })),
    );
    const user = userEvent.setup();
    show();

    await user.click(await screen.findByRole('button', { name: /add task/i }));
    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('refreshes the board on close after a task field was edited', async () => {
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
      http.patch('/api/v1/aito/tasks/:id', async ({ request }) =>
        HttpResponse.json({ ...taskFixture, ...(await request.json() as object) }),
      ),
    );
    const user = userEvent.setup();
    const { unmount } = show();

    const scan = await screen.findByLabelText('Scan3D');
    await user.clear(scan);
    await user.type(scan, '500');
    await waitFor(() => expect(screen.getByLabelText('Scan3D')).toHaveValue(500));

    boardFetches.mockClear();
    unmount();
    await waitFor(() => expect(boardFetches).toHaveBeenCalled());
  });

  it('does NOT refresh the board on close when no task was edited', async () => {
    const boardFetches = vi.fn();
    server.use(
      http.get('/api/v1/aito/', () => {
        boardFetches();
        return HttpResponse.json([]);
      }),
    );
    const { unmount } = show();
    await screen.findByText('Support de caméra');

    boardFetches.mockClear();
    unmount();
    // Give an invalidation a chance to land before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(boardFetches).not.toHaveBeenCalled();
  });
```

If the file has no `taskFixture` yet, reuse whatever `AitoTask` literal the existing task tests in that file already build; do not introduce a second shape.

The third test is what makes the second one meaningful. Without it, an unconditional invalidate-on-unmount passes the second test while costing a board refetch every time anyone glances at a card.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx`

Expected: the first two FAIL (`expected "spy" to be called at least once`); the third PASSES already (nothing invalidates today) — that is expected and correct. It is the guard that the fix does not overshoot.

- [ ] **Step 3: Invalidate the board on add and remove**

In `ProjectDetailPanel.tsx`, replace the `onSuccess` of `addTaskMutation` and `deleteTaskMutation`:

```tsx
  // Adding or removing a task changes the card's count, total and badge set,
  // so the board is invalidated alongside the task list.
  const invalidateTasksAndBoard = () => {
    queryClient.invalidateQueries({ queryKey: ['aito-tasks', project.id] });
    queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
  };

  const addTaskMutation = useMutation({
    mutationFn: () => api.createAitoTask(project.id, taskDraftToTaskCreate(emptyTaskDraft())),
    onSuccess: invalidateTasksAndBoard,
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (id: number) => api.deleteAitoTask(id),
    onSuccess: invalidateTasksAndBoard,
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });
```

- [ ] **Step 4: Defer field edits to panel close**

Add the ref beside `baselineRef`:

```tsx
  // Set when a task field is actually saved. Task-field edits PATCH per
  // keystroke, so they must never invalidate the board directly — that would
  // refetch every card on every character. The board is refreshed once, on
  // close, and only if something was really saved: a panel opened and closed
  // without edits must cost nothing.
  const tasksDirtyRef = useRef(false);
```

In `updateTaskMutation`'s `onSuccess`, after the existing `baselineRef.current.set(...)`:

```tsx
      tasksDirtyRef.current = true;
```

Add the unmount effect next to the other effects near the end of the component (before the `return`). It must have an **empty dependency array** so the cleanup runs on unmount only, and it must read `queryClient` and `project.id` through refs-free closure — both are stable for the lifetime of a mounted panel:

```tsx
  useEffect(
    () => () => {
      if (tasksDirtyRef.current) queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    },
    // Deliberately empty: this must fire exactly once, when the panel closes.
    // queryClient is a stable singleton from the provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx`

Expected: PASS, all three new tests plus every pre-existing test in the file — in particular the "does not clobber" regression tests, which prove the per-keystroke PATCH path is unchanged.

- [ ] **Step 6: Prove the third test can fail**

Temporarily drop the `if (tasksDirtyRef.current)` guard so the effect always invalidates, and re-run:

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx -t "does NOT refresh"`

Expected: FAIL. **Restore the guard** and re-run to confirm PASS.

- [ ] **Step 7: Build and lint**

Run: `cd frontend && npm run build && npm run lint`

Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/__tests__/components/ProjectDetailPanel.test.tsx
git commit -m "fix(aito): refresh the board card summary after task add, remove and edit"
```

---

### Task 4: Wide two-column modal and panel

**Files:**
- Modify: `frontend/src/components/aito/NewProjectModal.tsx:103,129-162`
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx:262,279-375`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks depend on. Task 5 assumes the right-hand column exists but does not import from here.

**No tests.** jsdom computes no CSS grid, so any assertion here would be a class-name string match: it would pass with a visually broken layout and fail on a harmless refactor. The layout is verified by eye. Every **existing** test in `ProjectDetailPanel.test.tsx`, `AitoPage.test.tsx` and `AitoPageClientSync.test.tsx` must still pass — they assert on content and roles, and this task must not move any of that.

- [ ] **Step 1: Widen and split the create modal**

In `NewProjectModal.tsx`, replace the dialog container `className` on line 103:

```tsx
      <div
        className={`bg-bambu-dark-secondary rounded-xl w-full border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in ${
          // The new-contact form is a short single-column form; at 1024px it
          // would sit marooned in whitespace. The width follows the mode, which
          // already changes the title too, so the resize reads as a mode switch
          // rather than a glitch.
          creatingClient ? 'max-w-md' : 'max-w-5xl'
        }`}
      >
```

- [ ] **Step 2: Make the modal body two columns**

Replace the scrolling body `<div>` (line 129) and its children so the client block and description sit in the left column and `TaskEditor` in the right. One scroll container, not two — nested scroll areas mean two scrollbars and focus-scroll surprises when tabbing between columns, and the left column is short enough that there is nothing to gain:

```tsx
            <div className="p-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-4 lg:gap-6">
                <div className="space-y-4 min-w-0">
                  {draft && (
                    <ClientSection
                      value={draft}
                      onChange={setDraft}
                      onCreateNew={() => setCreatingClient(true)}
                      defaultContactId={defaultId}
                      defaultContactName={defaultName}
                    />
                  )}
                  <div>
                    <label htmlFor="aito-description" className={labelCls}>
                      {t('aito.productDescription')}
                    </label>
                    <textarea
                      id="aito-description"
                      ref={textareaRef}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
                      }}
                      placeholder={t('aito.descriptionPlaceholder')}
                      rows={4}
                      required
                      className={`${inputCls} resize-none`}
                    />
                  </div>
                </div>

                <div className="min-w-0">
                  <TaskEditor
                    value={tasks}
                    onChange={setTasks}
                    onRemove={(index) => setTasks(tasks.filter((_, i) => i !== index))}
                  />
                </div>
              </div>
            </div>
```

`min-w-0` on both columns is required: a grid item's default `min-width: auto` lets long content (an unbroken client name, a wide `SearchableSelect`) push the column past its track and blow out the dialog.

- [ ] **Step 3: Widen and split the detail panel**

In `ProjectDetailPanel.tsx`, change `max-w-md` to `max-w-5xl` on line 262 (leave every other class, including `style={{ viewTransitionName: AITO_CARD_VT_NAME }}`, exactly as it is).

Then restructure the body: keep the single `overflow-y-auto` container, and put the description block and the `<dl>` in the left column, `TaskEditor` in the right:

```tsx
        <div className="p-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-4 lg:gap-6">
            <div className="space-y-4 min-w-0">
              {/* lines 280-318 verbatim: the description block,
                  <div className="flex items-start justify-between gap-2">
                  through its closing </div> after <SaveIndicator /> */}
              {/* lines 320-371 verbatim: the comment and the whole <dl>…</dl> */}
            </div>

            <div className="min-w-0 border-t border-bambu-dark-tertiary pt-4 lg:border-t-0 lg:pt-0">
              <TaskEditor value={tasks} onChange={handleTasksChange} onRemove={handleRemoveTask} />
            </div>
          </div>
        </div>
```

Move the existing description `<div className="flex items-start justify-between gap-2">…</div>` and the existing `<dl>…</dl>` into the left column **verbatim** — do not retype them, and do not change a class or a string inside them. Five existing tests assert on the `<dt>` labels (`Created:`, `Last activity:`, `Stage:`) and on the description text; they must keep passing untouched. The old wrapper `<div className="border-t border-bambu-dark-tertiary pt-4">` around `TaskEditor` is replaced by the right column's own classes, which restore that divider only in the stacked (below-`lg`) layout where it still makes sense.

- [ ] **Step 4: Verify nothing regressed**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx src/__tests__/pages/AitoPage.test.tsx src/__tests__/pages/AitoPageClientSync.test.tsx`

Expected: PASS, with no test edited in this task.

- [ ] **Step 5: Build and lint**

Run: `cd frontend && npm run build && npm run lint`

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/aito/NewProjectModal.tsx frontend/src/components/aito/ProjectDetailPanel.tsx
git commit -m "feat(aito): widen the create modal and detail panel to a two-column layout"
```

---

### Task 5: Put the Impression3D breakdown beside its inputs

**Files:**
- Modify: `frontend/src/components/aito/ImpressionFields.tsx:112-231`

**Interfaces:**
- Consumes: the wider right-hand column from Task 4.
- Produces: nothing.

**Why:** the eight-line cost breakdown is the single largest vertical block in a task. Stacked, it costs eight lines per task; placed beside the inputs it costs none, because the inputs are already three rows tall. This is the largest height reduction available without hiding information.

**No tests**, for the same reason as Task 4. The existing `ImpressionFields` behaviour tests — the `hasEdited` provenance gate, the `referenceDataLoading` hold, the `null`-vs-`0` handling — must all still pass, and none of them may be edited: this task changes wrapper markup only, never a handler, a query, an effect, or a label.

- [ ] **Step 1: Wrap the inputs and the breakdown in a two-column grid**

In `ImpressionFields.tsx`, the returned JSX currently is:

```tsx
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* six input blocks */}
      </div>
      {result && (
        <div className="space-y-1 pt-2 border-t border-bambu-dark-tertiary">
          {/* seven breakdown rows, the TTC total, and the forQuantity line */}
        </div>
      )}
    </div>
```

Change the outer wrapper and the breakdown's own wrapper, leaving **everything inside both** untouched:

```tsx
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* lines 115-199 verbatim: the six input blocks, printer through quantity */}
      </div>
      {result && (
        <div className="space-y-1 pt-2 border-t border-bambu-dark-tertiary lg:border-t-0 lg:pt-0 lg:border-l lg:border-bambu-dark-tertiary lg:pl-4">
          {/* lines 203-228 verbatim: the seven breakdown rows, the TTC total
              and the forQuantity line */}
        </div>
      )}
    </div>
```

Below `lg:` this is byte-for-byte the current layout: one column, the breakdown stacked under the inputs with a top border. At `lg:` and above the breakdown moves to the right half and the divider becomes a left border.

- [ ] **Step 2: Verify nothing regressed**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx`

Expected: PASS, with no test edited. This file carries the `ImpressionFields` coverage, including the frozen-cost provenance tests.

- [ ] **Step 3: Run the full frontend suite**

Run: `cd frontend && npm run test:run`

Expected: PASS.

- [ ] **Step 4: Build and lint**

Run: `cd frontend && npm run build && npm run lint`

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/ImpressionFields.tsx
git commit -m "feat(aito): lay the Impression3D cost breakdown beside its inputs on wide screens"
```

---

## Final verification

- [ ] Run `./test_backend.sh` — expect PASS except the six pre-existing `ruff format` failures named in Global Constraints.
- [ ] Run `./test_frontend.sh` — expect PASS.
- [ ] Run `cd frontend && npm run build && cd ..` — expect a clean bundle.
- [ ] Confirm `git status` shows **no** staged change to `static/index.html` and **no** staged `ViewTransitionWiring.test.tsx`.

**Verified by eye, not by test** — hand these to the user rather than claiming them:
1. The create modal and detail panel fill the screen width and are visibly shorter.
2. The card→panel morph, which now interpolates from a ~300px card to a 1024px panel. jsdom cannot test View Transitions; this is the one change most likely to look wrong.
3. A card whose project uses all four services — the badge row wraps to two lines at the narrowest column width.
4. Both surfaces at phone width, where the two-column grid must collapse back to the current single-column layout.
