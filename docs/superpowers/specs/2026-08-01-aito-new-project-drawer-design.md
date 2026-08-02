# Aito New-Project Drawer — Design

Date: 2026-08-01
Status: approved (validated interactively through 10 browser demo iterations; final prototype: `.superpowers/brainstorm/82134-1785628005/content/hybrid-drawer-v10.html`)

## Problem

The current `NewProjectModal` is a wide two-column modal with no explicit order: client, description, and a task editor that always renders four service fieldsets (three usually empty). Users reported two pain points: **no clear flow** (what to fill first, why Create is disabled) and **clunky task editing**. The modal also required typing a project description by hand and swapped the whole modal for a narrow create-client form.

## Decision summary

Replace the modal with a **full-height workbench drawer** sliding over the board (same surface family as `ProjectDetailPanel`), with a **guided work-first flow**, **chip-based task editing**, an **AI-generated project summary** (OpenRouter), **strict-but-guided creation rules revealed on blur**, a **locally persisted draft**, and a **hold-to-reset** control whose animation is promoted into the shared `HoldButton`.

## 1. Surface & layout

- A drawer slides from the right over the Aito board, full viewport height, ~79% width on desktop (board stays visible, blurred/dimmed behind). Escape / backdrop click / ✕ close it — **without losing the draft** (see §7).
- Header: title "New project" + close ✕ only. No totals in the header (the rail owns money).
- Body grid: **main column** (guided sections, scrolls) + **right rail** (288px, darker background, scrolls independently).
- The create-client form renders **inline inside the Client section** (disclosure), replacing the current whole-modal swap to `NewContactForm`'s narrow view. `NewContactForm`'s fields and mutation are reused as-is.
- Component: `NewProjectDrawer` replaces `NewProjectModal` (`frontend/src/components/aito/`). `AitoPage` renders it in place of the modal.

## 2. Flow — work first, client last

Main column, numbered collapsible sections with completion state (number → green ✓, hint text on the header):

1. **The work** — task cards (§3), "+ Add task" slot. Header hint: "N of M complete".
2. **Client** — entered last, once the project is feasible and agreed (§5). Opening this section is the trigger for AI summary generation (§4).

Right rail, top to bottom:

- **Summary (receipt)** — one line per task (name + total, amber "—" when unpriced), client line, project total.
- **✦ Résumé du projet** — the AI summary panel (§4).
- **Before you create** — the guidance checklist (§6).
- **Actions row** — square ↺ hold-to-reset button (icon only) + full-width **Create project** button.

## 3. Task cards — services become chips

Rework `TaskStepFields` (the edit mode shared by the drawer and `ProjectDetailPanel`) from four always-rendered fieldsets to progressive disclosure:

- A task card shows: title input (inline, dashed underline), task total in the header, ✕ remove (respecting existing `minRows`/pending rules), and a **chip row**: `+ Scan 3D`, `+ Modélisation 3D`, `+ Impression 3D`, `+ Usinage`.
- Clicking a chip **enables the service**: chip turns solid green, and a service line appears below (service name + price input + remove ✕). Removing the line or toggling the chip off sets the cost back to `null` (disabled — the existing null-vs-0 semantics are unchanged).
- **Impression 3D** additionally expands its parameter grid (printer, filament, weight, time, quantity, color) and auto-prices through the existing calculator path (`computeImpressionCost`); the computed price lands in the editable price input (override allowed), exactly as today.
- A card whose services are all disabled shows an amber "add a sub-task" hint in place of the total and an amber border. ("Sub-task" is the user-facing name for a priced service line.)
- Data model unchanged: `TaskDraft` and `taskDraftToTaskCreate` stay as they are. Chips are pure UI over the existing `null`-cost semantics.
- `TaskRow`'s read mode (`TaskStepList`), the done flags, and the detail panel's PATCH wiring are untouched.

## 4. AI project summary (OpenRouter)

The user no longer types the project description; it is generated.

- **Trigger**: when the user opens the **Client** section (the signal that task entry is finished). Re-opening Client after the tasks changed (compare a hash of task titles + enabled services) regenerates. No generation while tasks are being edited — one call per visit, not per keystroke.
- **Placement**: the rail's ✦ panel. Idle state: dashed border + italic hint ("generated when you reach the client step"). Busy state: shimmer. Generated: editable text (violet-accented panel), footer "Généré · <model>", plus **↻ Régénérer**.
- **Editable, with a latch**: any hand edit sets an `edited` flag — auto-regeneration stops permanently for this draft ("Modifié à la main" footer); only ↻ explicitly regenerates and clears the latch.
- **Content**: French, 1–2 sentences, short and factual, summarizing the tasks (names + enabled services, notable print parameters). Prompt lives server-side.
- **Fallback**: if OpenRouter is unconfigured, errors, or times out (8s), the panel becomes a **plain editable description field** pre-filled with an auto-built enumeration of the task titles. Creation is **never blocked by the AI**, and the description sent on create is never empty.
- **Backend**:
  - Settings (existing settings table): `openrouter_api_key` — **write-only secret**, same handling as the Zoho credentials; `openrouter_model` — plain string, default **`mistralai/mistral-small`** (cheap, strong French). Settings page gets an "AI" block with key + model fields.
  - New route `POST /api/v1/aito/summarize`: body = the task drafts (titles + enabled services + impression params); returns `{ summary: string, model: string }`. Async `httpx` call to OpenRouter chat completions; permission-gated like other aito routes; classified for API keys (see registration gotchas).
- On create, the summary text is sent as the project `description` — no schema change.

## 5. Client rules

- **Every project has a client account.** The default is the walk-in account **"Client de passage"** (the existing default contact). (A later v2 will enforce real accounts and retire the walk-in; nothing here should make that harder.)
- The Client section shows the selected account chip (avatar, name, coordinates, "Change" → `ClientCombobox` search / inline create) and **Téléphone / Email** fields.
  - For a real Zoho client these are the existing `ClientSection` fields (written back to Zoho).
  - For **Client de passage**, phone/email are stored **in the app DB on the project row** — new nullable columns `client_phone`, `client_email` on the aito project table (additive `ALTER TABLE` in `run_migrations()`), never written to the shared Zoho walk-in contact.
- **Reachability rule (blocking)**: at least one of phone or email, for every client including the walk-in. Enforced in the UI (checklist + disabled Create) and server-side on the create route (400 otherwise).
- **Soft warning (non-blocking)**: exactly one channel captured → small amber ⚠ under the fields ("Pas d'email — le devis ne pourra pas être envoyé par mail" / "Pas de téléphone — pensez à le demander").
- **Formatting invariant**: new clients are stored as **Prénom Capitalisé** (title-cased segments, hyphens preserved) and **NOM EN MAJUSCULES** — already implemented in `NewContactForm` client-side; the backend create-contact route must apply the same normalization so no other caller can bypass it.
- Existing phone/email format validation (`clientDraft` utils) and Zoho-not-configured messaging are unchanged.

## 6. Validation & guidance — "Before you create"

Three creation invariants:

1. The project has **at least one task**.
2. **Each task has at least one sub-task** (priced service; `projectHasPricedService` already encodes this).
3. The client is **reachable** (phone or email — §5). The account itself always exists (walk-in default).

Guidance model — the checklist in the rail is the single place errors appear, and they are **revealed on blur**:

- Each rule renders as a checklist line with three states: **neutral** (gray, untouched), **error** (amber, names the offender: `"Support antenne" needs at least one sub-task`), **satisfied** (green ✓, e.g. "2 tasks — at least one required", "Client reachable — +689 …").
- A rule's error state only shows after the user has *visited and left* the relevant surface (focusout of a task card / the client fields) — never mid-typing. Structural violations that can't be "mid-typed" (zero tasks after a removal) show immediately.
- The **Create project** button is disabled until all three pass (plus Zoho configured, as today). Clicking a disabled Create reveals all pending errors (same "reveal on submit" behavior the current modal has).
- The AI summary line in the checklist is informational (✦ waits for the client step / generated), never blocking.

## 7. Persistence & reset

- **No Cancel button.** Closing the drawer keeps everything.
- **Local draft persistence**: the whole draft (tasks, client selection + phone/email, summary text, edited-latch, section open-states not included) is serialized to `localStorage` (key `aito.newProjectDraft.v1`) on change (debounced). Reopening the drawer restores it. Cleared on successful create and on reset.
- **Hold-to-reset**: a square icon button (↺) left of Create. Hold 0.5s to wipe the draft back to one empty task + walk-in client.

### Hold animation (shared)

The reset button's hold choreography is added to the **shared `HoldButton` perimeter variant** (which already draws a top-centre-start clockwise border trace), so it also upgrades **"mark as sent"** (`QuoteStatusActions`) and **"done"** (`ProjectDoneAction`) on the project card:

- **Progress**: the border stroke traces from **top centre**, clockwise, linear over the hold duration, with a soft glow (layered drop-shadows in the action color — red for destructive reset, existing colors for sent/done).
- **Inflate**: the whole button scales up (~1.14 for the square reset; a gentler factor may suit inline card buttons — implementer's judgement, one shared token) over the full hold via a slow transition; releasing early deflates and rewinds the ring quickly.
- **Completion**: the ring **stays at 100% and fades out** (no rewind) while the button plays a **damped-spring bounce** (≈1.14 → 0.94 → 1.045 → 0.985 → 1.006 → 0.998 → 1 over ~0.65s, ease-in-out between keyframes); then the action fires.
- `motion-reduce`: keep the existing shortened-duration behavior; skip inflate/bounce, keep the ring.
- `DeleteHoldButton` (which wraps `HoldButton`) inherits automatically.

## Error handling

- OpenRouter failure/timeout/unconfigured → fallback description field (§4); a quiet inline notice, no toast storm.
- Create POST failure → existing error path (toast), draft retained.
- Zoho unconfigured → existing "configure Zoho" message in the Client section; Create disabled (unchanged).
- Server-side create validation mirrors the three invariants (defense in depth; the UI normally prevents them).

## Testing

- **Frontend (Vitest)**: drawer flow (sections, blur-reveal states, Create gating for each invariant), chip toggling ↔ `TaskDraft` null-cost semantics, AI panel state machine (idle → busy → generated → edited-latch → fallback), draft persistence round-trip (localStorage mock), HoldButton new states (class/DOM assertions for holding/complete/bounce), soft-warning display rules.
- **Backend (pytest)**: `/aito/summarize` (mocked OpenRouter: success, error, timeout), settings key write-only behavior, create-route validation (no task / unpriced task / unreachable client → 400), contact-name normalization server-side, migration adds `client_phone`/`client_email`.
- i18n: all new strings in EN + FR (the i18n gate rejects EN placeholders in FR).
- Sidebar/nav tests unaffected (no new nav entry).

## Out of scope

- Retiring "Client de passage" and enforcing real accounts (planned v2).
- Reworking `ProjectDetailPanel`'s layout (it only inherits the `TaskStepFields` chip rework and the `HoldButton` upgrade).
- Quote preview inside the drawer (proposition B's review step — not chosen).
