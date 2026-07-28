# Aito Card Header, Modal Latency and Morph Z-Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Aito "New project" modal's client block appear instantly, restructure the board card so it drags only from a header grip and opens only from its body, drop phone/email from the card face, and fix the card→panel morph painting the backdrop over the card.

**Architecture:** The modal's latency is removed by making `GET /zoho/status`'s reachability probe opt-in, so three of its four callers answer from the local settings table alone. The card gains a three-zone structure (header / body button / footer) with dnd-kit's activator moved onto a dedicated grip via `setActivatorNodeRef`. The morph fix is two CSS rules pinning view-transition paint order.

**Tech Stack:** FastAPI + Pydantic (backend), pytest with `httpx.MockTransport`; React 19 + TanStack Query + dnd-kit + Tailwind 4 (frontend), Vitest + Testing Library + MSW.

**Spec:** `docs/superpowers/specs/2026-07-27-aito-card-header-and-modal-latency-design.md`

## Codebase baseline

Verified against `0d4bfd858` (2026-07-27), immediately after the client-input plan landed.

| Fact | Detail |
|---|---|
| `GET /zoho/status` | Always calls `get_access_token`; `ZohoStatus.reachable` is `bool` |
| `zoho-status` callers | 4, all on the bare key `['zoho-status']` — `NewProjectModal`, `ClientSection`, `ZohoSettings` (passive), `ZohoSettings` Test button (`queryClient.fetchQuery`, `staleTime: 0`) |
| `SortableCard` | In `BoardColumn.tsx`; spreads `{...attributes} {...listeners}` on the wrapper, which also carries `touch-none` |
| `CardView` | Root has `onClick={onExpand}`; renders client name, `tel:` link, description, elapsed + delete; a `ChevronDown` button top-right also expands |
| `PointerSensor` | `activationConstraint: { distance: 8 }` in `AitoPage.tsx` |
| `aito.showDetails` | Used in exactly one place (`CardView.tsx:42`, the chevron), present in all 12 locales |
| `GripVertical` | Ships in the installed `lucide-react` |
| Card tests | No `CardView`-specific file; cards are covered inside `AitoPage.test.tsx` |

## Global Constraints

- Python line length 120; Ruff rules `E, W, F, I, B, C4, UP, ARG, SIM`; double quotes; Python 3.10 target.
- Use `./venv/bin/python3` for every Python command. `ruff` is on PATH.
- TypeScript strict, no unused locals/parameters, ES2022. Path alias `@/` → `frontend/src/`.
- All commands run **from the project root**.
- Every new user-facing string needs a key in **all 12** locale files under `frontend/src/i18n/locales/` (`en, de, es, fr, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`), genuinely translated. `frontend/src/__tests__/i18n/locales.test.ts` enforces exact `en` parity against `de, fr, it, ja, pt-BR, zh-CN` and **fails on extras as well as omissions**, so a removed key must be removed from all 12. `frontend/scripts/check-i18n-parity.mjs` additionally fails when a non-English value is byte-identical to English.
- **Known pre-existing failures, not yours:** a repo-wide `ruff format --check` fails on 6 unrelated files (`camera.py`, `library.py`, `test_camera_api.py`, `test_library_file_history_api.py`, `test_aito_project_model.py`, `test_camera_chamber_stream.py`) — do not reformat them; and 2 tests in `test_extract_video_last_frame.py` fail from a missing `/usr/bin/ffmpeg`. Verify the backend with `./venv/bin/python3 -m pytest backend/tests/unit/ -q && ruff check backend/`.
- **Working tree:** `static/index.html` (build output) and the untracked `frontend/src/__tests__/components/ViewTransitionWiring.test.tsx` belong to the repo owner. Stage by explicit path; never `git add -A`, `git add .` or `git add frontend/src`.
- Commit after every task. Do not push.

---

## File Structure

**Backend — modify:**

| File | Change |
|---|---|
| `backend/app/api/routes/zoho.py` | `probe` query param; `ZohoStatus.reachable: bool \| None` |
| `backend/tests/unit/test_zoho_routes.py` | Probe/no-probe tests; update 3 existing status tests |

**Frontend — create:**

| File | Responsibility |
|---|---|
| `frontend/src/__tests__/components/AitoCardView.test.tsx` | Card structure: drag source, click zones, absent phone/email |

**Frontend — modify:**

| File | Change |
|---|---|
| `frontend/src/api/client.ts` | `getZohoStatus(probe?)`; `reachable: boolean \| null` |
| `frontend/src/components/aito/NewProjectModal.tsx` | Unprobed query key |
| `frontend/src/components/aito/ClientSection.tsx` | Unprobed query key |
| `frontend/src/components/ZohoSettings.tsx` | Unprobed passive query; probed Test button |
| `frontend/src/components/aito/CardView.tsx` | Header / body button / footer; grip; drop phone + chevron |
| `frontend/src/components/aito/BoardColumn.tsx` | `setActivatorNodeRef` wiring |
| `frontend/src/pages/AitoPage.tsx` | Drop `activationConstraint` |
| `frontend/src/index.css` | Two `::view-transition-group` z-index rules |
| `frontend/src/__tests__/pages/AitoPage.test.tsx` | Update 3 invalidated tests |
| `frontend/src/i18n/locales/*.ts` (12) | Add `aito.dragHandle`, remove `aito.showDetails` |

---

### Task 1: Make the reachability probe opt-in

**Files:**
- Modify: `backend/app/api/routes/zoho.py`
- Test: `backend/tests/unit/test_zoho_routes.py`

**Interfaces:**
- Consumes: `zoho_service.get_default_contact(db) -> tuple[str, str]` and `zoho_service.is_configured(db) -> bool`, both settings-only reads that make no upstream request.
- Produces: `GET /zoho/status?probe=<bool>`; `ZohoStatus.reachable: bool | None` where `None` means "not probed".

- [ ] **Step 1: Write the failing tests**

In `backend/tests/unit/test_zoho_routes.py`, **replace** the three existing status tests (`test_status_unconfigured_still_returns_default_contact`, `test_status_uses_configured_default_contact`, `test_status_configured_reachable`) with these five. The first two change because `reachable` is now `None` when unprobed:

```python
@pytest.mark.asyncio
async def test_status_unconfigured_still_returns_default_contact(async_client):
    r = await async_client.get("/api/v1/zoho/status")
    assert r.status_code == 200
    assert r.json() == {
        "configured": False,
        "reachable": None,
        "default_contact_id": "66407000001237340",
        "default_contact_name": "Client de passage",
    }


@pytest.mark.asyncio
async def test_status_uses_configured_default_contact(async_client):
    await async_client.put(
        "/api/v1/settings/",
        json={"zoho_default_contact_id": "abc123", "zoho_default_contact_name": "Walk-in"},
    )
    body = (await async_client.get("/api/v1/zoho/status")).json()
    assert body["default_contact_id"] == "abc123"
    assert body["default_contact_name"] == "Walk-in"


@pytest.mark.asyncio
async def test_status_without_probe_makes_no_upstream_request(async_client):
    """The Aito modal blocks its client block on this call, so it must never
    wait on a Zoho round trip it does not read."""
    await _configure(async_client)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})

    zoho_service.transport = httpx.MockTransport(handler)
    body = (await async_client.get("/api/v1/zoho/status")).json()
    assert calls["n"] == 0
    assert body["configured"] is True
    assert body["reachable"] is None


@pytest.mark.asyncio
async def test_status_with_probe_reports_reachable(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json={"access_token": "at", "expires_in": 3600})
    )
    assert (await async_client.get("/api/v1/zoho/status?probe=true")).json() == {
        "configured": True,
        "reachable": True,
        "default_contact_id": "66407000001237340",
        "default_contact_name": "Client de passage",
    }


@pytest.mark.asyncio
async def test_status_with_probe_reports_unreachable_on_upstream_error(async_client):
    await _configure(async_client)
    zoho_service.transport = httpx.MockTransport(lambda request: httpx.Response(500, text="boom"))
    body = (await async_client.get("/api/v1/zoho/status?probe=true")).json()
    assert body["configured"] is True
    assert body["reachable"] is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py -v -k status`
Expected: FAIL — `reachable` is `false`, not `null`, and `?probe=true` is ignored.

- [ ] **Step 3: Implement**

In `backend/app/api/routes/zoho.py`, change the model:

```python
class ZohoStatus(BaseModel):
    configured: bool
    # None means "not probed" — distinct from False ("probed and unreachable").
    reachable: bool | None
    default_contact_id: str
    default_contact_name: str
```

and the route:

```python
@router.get("/status", response_model=ZohoStatus)
async def zoho_status(
    probe: bool = False,
    db: AsyncSession = Depends(get_db),
    # Any-of: the Aito create modal (aito:create) AND the settings Test button
    # (settings:read) both need this endpoint.
    _: User | None = RequireAnyPermissionIfAuthEnabled(Permission.AITO_CREATE, Permission.SETTINGS_READ),
):
    """Connection state for the Zoho integration.

    ``configured`` and the default contact are settings-table reads. ``reachable``
    costs an OAuth round trip, so it is only established when ``probe`` is set —
    the Aito modal gates its client block on this call and never reads it.
    """
    default_id, default_name = await zoho_service.get_default_contact(db)
    configured = await zoho_service.is_configured(db)
    if not configured or not probe:
        return ZohoStatus(
            configured=configured,
            reachable=None,
            default_contact_id=default_id,
            default_contact_name=default_name,
        )
    try:
        await zoho_service.get_access_token(db)
        reachable = True
    except ZohoNotConfiguredError:
        # Settings were cleared between the is_configured() check above and here.
        configured, reachable = False, None
    except ZohoUpstreamError as e:
        logger.warning("Zoho unreachable: %s", e)
        reachable = False
    return ZohoStatus(
        configured=configured,
        reachable=reachable,
        default_contact_id=default_id,
        default_contact_name=default_name,
    )
```

- [ ] **Step 4: Run the backend tests**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/test_zoho_routes.py backend/tests/unit/test_zoho_settings.py -v`
Expected: PASS

- [ ] **Step 5: Run the full backend suite and lint**

Run: `./venv/bin/python3 -m pytest backend/tests/unit/ -q && ruff check backend/`
Expected: PASS apart from the 2 known ffmpeg failures.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/routes/zoho.py backend/tests/unit/test_zoho_routes.py
git commit -m "perf(zoho): make the /zoho/status reachability probe opt-in"
```

---

### Task 2: Split the client cache key so the modal opens instantly

**Files:**
- Modify: `frontend/src/api/client.ts`, `frontend/src/components/aito/NewProjectModal.tsx`, `frontend/src/components/aito/ClientSection.tsx`, `frontend/src/components/ZohoSettings.tsx`

**Interfaces:**
- Consumes: `GET /zoho/status?probe=<bool>` from Task 1.
- Produces: `api.getZohoStatus(probe?: boolean)`; `ZohoStatus.reachable: boolean | null`; query keys `['zoho-status', { probe: false }]` and `['zoho-status', { probe: true }]`.

- [ ] **Step 1: Update the API client**

In `frontend/src/api/client.ts`, widen the type:

```ts
export interface ZohoStatus {
  configured: boolean;
  /** null when the caller did not ask for a reachability probe. */
  reachable: boolean | null;
  default_contact_id: string;
  default_contact_name: string;
}
```

and the method:

```ts
  getZohoStatus: (probe = false) =>
    request<ZohoStatus>(`/zoho/status${probe ? '?probe=true' : ''}`),
```

- [ ] **Step 2: Point the three cheap callers at the unprobed key**

The key split is load-bearing: the Test button uses `queryClient.fetchQuery` on the same key, and a shared entry would let an unprobed `reachable: null` reach the one control whose job is reporting connectivity.

In `frontend/src/components/aito/NewProjectModal.tsx` and `frontend/src/components/aito/ClientSection.tsx`, replace each `useQuery({ queryKey: ['zoho-status'], queryFn: api.getZohoStatus, staleTime: 60_000 })` with:

```tsx
  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });
```

In `frontend/src/components/ZohoSettings.tsx`, the passive query reads only `.configured` (secret-saved badges and placeholders), so it takes the same unprobed key:

```tsx
  const { data: zohoStatus } = useQuery<ZohoStatus>({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
  });
```

- [ ] **Step 3: Point the Test button at the probed key**

In `handleTestConnection` in `frontend/src/components/ZohoSettings.tsx`:

```tsx
      const result = await queryClient.fetchQuery({
        queryKey: ['zoho-status', { probe: true }],
        queryFn: () => api.getZohoStatus(true),
        staleTime: 0,
      });
```

The three-state rendering below it (`configured && reachable` → connected, `configured` alone → unreachable, else not configured) is unchanged and correct: this call always probes, so it never receives `null`.

- [ ] **Step 4: Type-check and build**

Run: `cd frontend && npx tsc --noEmit && npm run build && cd ..`
Expected: no errors. If any test's MSW handler for `/api/v1/zoho/status` returns an object without `reachable`, that is fine — the field is nullable now.

- [ ] **Step 5: Run the frontend suite**

Run: `./test_frontend.sh`
Expected: PASS. Known flakes that pass on isolated re-run: `PrintModal.test.tsx`, `AitoPage.test.tsx` on `scrollIntoView`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/components/aito/NewProjectModal.tsx frontend/src/components/aito/ClientSection.tsx frontend/src/components/ZohoSettings.tsx
git commit -m "perf(aito): stop the client block waiting on a Zoho reachability probe"
```

---

### Task 3: Restructure the card — header, grip handle, body button

This is the largest task. It changes the card's markup, moves the drag activator, removes two elements, and invalidates three existing tests.

**Files:**
- Modify: `frontend/src/components/aito/CardView.tsx`, `frontend/src/components/aito/BoardColumn.tsx`, `frontend/src/pages/AitoPage.tsx`, `frontend/src/__tests__/pages/AitoPage.test.tsx`, all 12 `frontend/src/i18n/locales/*.ts`
- Create: `frontend/src/__tests__/components/AitoCardView.test.tsx`

**Interfaces:**
- Consumes: `DeleteHoldButton`, `formatElapsedTime`/`parseUTCDate`, `AitoProject`.
- Produces:

```ts
export interface CardViewProps {
  project: AitoProject;
  overlay?: boolean;
  onDelete?: () => void;
  onExpand?: () => void;
  /** dnd-kit's setActivatorNodeRef — omitted by the DragOverlay clone. */
  dragHandleRef?: (element: HTMLElement | null) => void;
  /** dnd-kit's attributes + listeners, spread onto the grip. */
  dragHandleProps?: Record<string, unknown>;
}
```

- [ ] **Step 1: Add the i18n key and remove the dead one**

In all 12 locale files, inside the `aito` block: **add** `dragHandle` and **remove** `showDetails` (the chevron that used it is deleted in Step 5; the parity test fails on extras, so it cannot be left behind).

English: `dragHandle: 'Drag to reorder',`
French: `dragHandle: 'Glisser pour réordonner',`

Translate the same string for `de, es, it, ja, ko, pt-BR, ru, tr, zh-CN, zh-TW`. Do not leave English in a non-English file — `frontend/scripts/check-i18n-parity.mjs` fails on values byte-identical to English.

- [ ] **Step 2: Write the failing card tests**

Create `frontend/src/__tests__/components/AitoCardView.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CardView } from '../../components/aito/CardView';
import type { AitoProject } from '../../api/client';

const project: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

describe('CardView', () => {
  it('puts the client name in the header and never renders phone or email', () => {
    render(<CardView project={project} onExpand={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByText(/87123456/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hi@acme\.pf/)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('falls back to the no-client label when the card has no client', () => {
    render(<CardView project={{ ...project, client_name: null }} onExpand={vi.fn()} />);
    expect(screen.getByText(/no client|sans client/i)).toBeInTheDocument();
  });

  it('opens from the body, and the body is reachable by keyboard', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<CardView project={project} onExpand={onExpand} onDelete={vi.fn()} />);
    const body = screen.getByRole('button', { name: /Support de caméra/ });
    await user.click(body);
    expect(onExpand).toHaveBeenCalledTimes(1);

    body.focus();
    await user.keyboard('{Enter}');
    expect(onExpand).toHaveBeenCalledTimes(2);
  });

  it('does not open when the header or the grip is clicked', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={project}
        onExpand={onExpand}
        onDelete={vi.fn()}
        dragHandleRef={vi.fn()}
        dragHandleProps={{}}
      />,
    );
    await user.click(screen.getByText('ACME SARL'));
    await user.click(screen.getByRole('button', { name: /drag|glisser/i }));
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('renders a static grip with no button in the drag overlay', () => {
    render(<CardView project={project} overlay />);
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoCardView.test.tsx && cd ..`
Expected: FAIL — the phone link still renders and there is no body button.

- [ ] **Step 4: Rewrite `CardView`**

Replace `frontend/src/components/aito/CardView.tsx` entirely:

```tsx
import { useTranslation } from 'react-i18next';
import { GripVertical } from 'lucide-react';
import { DeleteHoldButton } from './DeleteHoldButton';
import type { AitoProject } from '../../api/client';
import { formatElapsedTime, parseUTCDate } from '../../utils/date';

export interface CardViewProps {
  project: AitoProject;
  overlay?: boolean;
  onDelete?: () => void;
  onExpand?: () => void;
  /** dnd-kit's setActivatorNodeRef — omitted by the DragOverlay clone. */
  dragHandleRef?: (element: HTMLElement | null) => void;
  /** dnd-kit's attributes + listeners, spread onto the grip. */
  dragHandleProps?: Record<string, unknown>;
}

/** Presentational card, shared by the in-column sortable wrapper and the
 *  DragOverlay clone.
 *
 *  Three zones with distinct jobs: the header carries the client name and is
 *  the ONLY drag source (via the grip); the body is the only thing that opens
 *  the detail panel; the footer holds the timestamp and delete. Phone and email
 *  live in the detail panel, not here.
 *
 *  The footer sits outside the body button because a <button> may not contain
 *  another button — the delete control could not otherwise exist. */
export function CardView({
  project,
  overlay = false,
  onDelete,
  onExpand,
  dragHandleRef,
  dragHandleProps,
}: CardViewProps) {
  const { t, i18n } = useTranslation();
  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);
  const elapsed = formatElapsedTime(project.created_at, t);
  const dateTitle = [
    created && t('aito.created', { date: created.toLocaleString(i18n.language) }),
    updated && t('aito.updated', { date: updated.toLocaleString(i18n.language) }),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      data-aito-card
      data-aito-card-id={project.id}
      className={`group relative rounded-xl border bg-bambu-dark-secondary select-none ${
        overlay
          ? 'rotate-1 scale-[1.02] border-bambu-green/40 shadow-2xl cursor-grabbing'
          : 'border-bambu-dark-tertiary card-shadow transition-[border-color,box-shadow] duration-100 hover:border-bambu-green/40 hover:shadow-lg'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-bambu-dark-tertiary rounded-t-xl border-b border-bambu-dark-tertiary">
        <p
          className={`flex-1 text-sm font-medium truncate ${
            project.client_name ? 'text-white' : 'text-bambu-gray'
          }`}
        >
          {project.client_name ?? t('aito.noClient')}
        </p>
        {dragHandleProps ? (
          <button
            type="button"
            ref={dragHandleRef}
            aria-label={t('aito.dragHandle')}
            {...dragHandleProps}
            // touch-none belongs on the grip, not the card: on the card it
            // would block touch-scrolling the column from anywhere on a card.
            className="touch-none flex-shrink-0 p-1 -m-1 rounded-md text-bambu-gray cursor-grab active:cursor-grabbing hover:text-white hover:bg-bambu-dark-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <GripVertical className="w-4 h-4" />
          </button>
        ) : (
          <GripVertical className="w-4 h-4 flex-shrink-0 text-bambu-gray" aria-hidden="true" />
        )}
      </div>

      {onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          className="w-full text-left px-3 pt-2.5 pb-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green/40"
        >
          <span className="block text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </span>
        </button>
      ) : (
        <div className="px-3 pt-2.5 pb-1.5">
          <p className="text-sm text-white whitespace-pre-wrap break-words line-clamp-3">
            {project.description}
          </p>
        </div>
      )}

      <div className="px-3 pb-2 flex items-center justify-between">
        <span className="text-xs text-bambu-gray" title={dateTitle}>
          {elapsed}
        </span>
        {onDelete && (
          <DeleteHoldButton onDelete={onDelete} label={t('aito.deleteTitle')} hint={t('aito.holdToDelete')} />
        )}
      </div>
    </div>
  );
}
```

Note what left: `onClick` on the root, `cursor-grab` on the root, the `ChevronDown` import and button, the `tel:` link, and the `p-3` padding (each zone now pads itself).

- [ ] **Step 5: Move the drag activator onto the grip**

In `frontend/src/components/aito/BoardColumn.tsx`, change `SortableCard`:

```tsx
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: project.id,
    transition: transitionConfig,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`${animateIn ? 'animate-rise' : ''} ${isDragging ? 'opacity-30' : ''}`}
    >
      <CardView
        project={project}
        onDelete={onDelete}
        onExpand={onExpand}
        dragHandleRef={setActivatorNodeRef}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
```

`attributes` must go on the grip alongside `listeners`: it carries the `role`, `tabIndex` and `aria-describedby` that make keyboard dragging work, so leaving it on the wrapper would keep the whole card as the keyboard drag target. `touch-none` moves to the grip inside `CardView`.

- [ ] **Step 6: Tighten, but do not remove, the pointer activation constraint**

In `frontend/src/pages/AitoPage.tsx`:

```tsx
    // A small threshold still earns its keep with a dedicated grip: without any
    // constraint, a plain click on the grip starts and immediately ends a drag,
    // which flashes the card to opacity-30 and renders the DragOverlay for a
    // frame. `computeMoveTarget` returns 'noop' so nothing is persisted — the
    // cost is purely visual, and 4px removes it while still feeling immediate.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
```

The original 8px existed to tell a click from a drag when the *whole card* was the handle; that job is gone, so the threshold can shrink. It cannot go to zero, for the reason in the comment.

- [ ] **Step 7: Run the card tests**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoCardView.test.tsx && cd ..`
Expected: PASS — five tests.

- [ ] **Step 8: Update the three invalidated tests in `AitoPage.test.tsx`**

These break by design. **Do not delete coverage** — retarget it:

1. `leads with the client name and a tel: phone link, without the row id` → rename to `leads with the client name in the header, without the row id or a phone link`. Keep the client-name and no-row-id assertions; replace the `tel:` assertion with `expect(document.querySelector('a[href^="tel:"]')).toBeNull()`.
2. `does not expand the card when the phone link is clicked` → **delete it**. The card has no phone link any more, and the equivalent guard (the header does not expand) is covered by `AitoCardView.test.tsx`.
3. `opens the panel from the keyboard via the details button` → rename to `opens the panel from the keyboard via the card body` and target the body button (`getByRole('button', { name: /<description text>/ })`) instead of the removed details button.

- [ ] **Step 9: Full frontend verification**

Run: `cd frontend && npx tsc --noEmit && npm run build && cd .. && ./test_frontend.sh`
Expected: build succeeds; TypeScript, ESLint, i18n parity and every Vitest suite pass. Re-run `PrintModal.test.tsx` or `AitoPage.test.tsx` in isolation before treating either as a real failure.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/aito/CardView.tsx frontend/src/components/aito/BoardColumn.tsx frontend/src/pages/AitoPage.tsx frontend/src/__tests__/components/AitoCardView.test.tsx frontend/src/__tests__/pages/AitoPage.test.tsx frontend/src/i18n/locales
git commit -m "feat(aito): card header with a dedicated drag grip and body-only expand"
```

---

### Task 4: Fix the morph z-order

**Files:**
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: the `aito-card` and `aito-backdrop` view-transition names set in `useCardMorph.ts` and `ProjectDetailPanel.tsx`.
- Produces: nothing importable — CSS only.

- [ ] **Step 1: Add the two rules**

In `frontend/src/index.css`, immediately after the existing
`::view-transition-old(aito-card), ::view-transition-new(aito-card)` block:

```css
/* Paint order for the card morph. Without an explicit z-index the browser falls
   back to capture order, and on OPEN that order is wrong: `aito-card` already
   exists in the old state (as the board card) and is captured first, while
   `aito-backdrop` is new and appended after it — so the darkening backdrop
   would paint over the morphing card for the whole 350ms and the panel would
   snap to full brightness only when the real DOM took over. */
::view-transition-group(aito-backdrop) {
  z-index: 0;
}
::view-transition-group(aito-card) {
  z-index: 1;
}
```

- [ ] **Step 2: Verify the build and suite still pass**

Run: `cd frontend && npm run build && cd .. && ./test_frontend.sh`
Expected: PASS. This change is CSS-only and has no unit test — the View Transitions API is not implemented in jsdom.

- [ ] **Step 3: Verify by eye**

Open the Aito board, click a card, and confirm the panel is at full brightness for the whole expansion instead of darkening first. Then close it and confirm the collapse is unchanged — closing was already correct, because both names exist in the old state there and the backdrop is the panel's ancestor. If closing *was* also wrong before this change, say so: the diagnosis in the spec would be incomplete and worth revisiting.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css
git commit -m "fix(aito): pin card-morph paint order so the backdrop stays behind the card"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Opt-in probe, `reachable: bool \| None` | 1 |
| `getZohoStatus(probe)`, four call sites, key split | 2 |
| Header, grip, body button, footer, phone/email removal | 3 |
| `activationConstraint` 8px → 4px | 3 |
| `aito.dragHandle` added, `aito.showDetails` removed | 3 |
| Morph z-order | 4 |

**Type consistency checked:** `ZohoStatus.reachable` is `bool | None` in Pydantic and `boolean | null` in TypeScript. `CardViewProps.dragHandleRef` matches dnd-kit's `setActivatorNodeRef` signature `(element: HTMLElement | null) => void`. `dragHandleProps` is spread, so it is typed loosely on purpose — dnd-kit's `attributes` and `listeners` have no single exported type.

**Known follow-ups, deliberately out of scope:** the detail panel keeps rendering phone and email and is unchanged; the residual `NewContactForm` gate (disables its submit on an invisible error) from the previous plan is untouched.
