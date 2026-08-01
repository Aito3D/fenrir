# Aito Detail Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `ProjectDetailPanel`'s hierarchy around a read-only stage rail, with ranked surface elevation, so the client, the money and the stage are readable at a glance and a step is ticked through a row-sized target.

**Architecture:** Frontend only. The panel keeps its three-column skeleton; the left column becomes four cards (description, stage rail, quote, record), the middle column gains per-task progress and row-wide step toggles, and a new footer bar takes the destructive and secondary actions out of the header. Every field needed already ships on `AitoProject`; the one new fetch is a single-row query against the existing events endpoint.

**Tech Stack:** React 19, TypeScript (strict), TanStack Query v5, Tailwind CSS 4, Vitest + Testing Library, i18next.

## Global Constraints

- **No backend change.** No new columns, routes, or schema fields. `column`, `move_lock`, `task_pending`, `steps_total`, `steps_done` are already on `AitoProject`.
- **`utils/aitoBoardRules.ts` is read-only.** It mirrors `backend/app/services/aito_board_rules.py` and is pinned by a generated contract fixture (`backend/tests/aito_rules_fixture.py`). Read `STAGES`, `SERVICES`, `taskCost`; add nothing to it.
- **Four services, three work stages.** `SERVICES = ['scan','modelisation','impression','usinage']`. `STAGES` maps `scan→[scan]`, `model→[modelisation]`, `print→[impression,usinage]`. Printing and machining share one column.
- **A column is derived, never set.** The stage rail is read-only. Do not add a click handler, a mutation, or a `<button>` to it.
- **No literal hex, and no `color-mix` against `#000`/`#fff`** in component styles. Use `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--accent`, `--card-shadow`. Fixed-percentage darkening breaks light mode.
- **i18n gate:** `npm run test:run` runs `scripts/check-i18n-parity.mjs` over **en, de, fr, it, ja, pt-BR, zh-CN, zh-TW**. It fails on a missing key, a mismatched `{{placeholder}}` set, **or a non-English value identical to English**. Every new key needs a real translation in all seven non-English locales. `es`, `ko`, `ru`, `tr`, `uk` are not gated; add keys there too for consistency, English is acceptable in those five.
- **Line length / style:** Prettier + ESLint flat config, `npm run lint`. Strict TS, no unused locals or params.
- **Run from project root:** `./test_frontend.sh`. A single file: `cd frontend && npx vitest run src/__tests__/components/Foo.test.tsx`.
- **Reduced motion:** every transition needs a `motion-reduce:transition-none` variant, matching the existing components.

---

## File Structure

| File | Responsibility |
| ---- | -------------- |
| `components/aito/services.ts` | **Modify.** Add `stagesWithWork()` — the join between a project's tasks and the board's work stages. |
| `components/aito/StageRail.tsx` | **Create.** The vertical stage list with per-stage progress and the lock sentence. Purely presentational. |
| `components/aito/TaskStepList.tsx` | **Modify.** Row-wide toggle, checkbox, stage swatch. |
| `components/aito/TaskRow.tsx` | **Modify.** Per-task progress bar and `n/m` count. |
| `components/aito/ProjectDetailPanel.tsx` | **Modify.** Header, four-card left column, footer bar, focus, surfaces. Local sub-components: `PanelHeader`, `ValueRing`, `RecordCard`, `PanelFooter`. |
| `hooks/useLatestProjectEvent.ts` | **Create.** One-row `depth: 'everything'` query for the Record card's last-activity actor. |
| `i18n/locales/*.ts` | **Modify.** 15 new keys × 13 locales. |

`ProjectDetailPanel.tsx` is 525 lines before this and will grow. `StageRail` and `useLatestProjectEvent` come out as their own files; the header/record/footer stay local to the panel because they are single-use and read the same `project` prop.

---

### Task 1: Stage aggregation helper

The join between "a task's steps" and "the board's columns". Everything downstream reads this.

**Files:**
- Modify: `frontend/src/components/aito/services.ts`
- Test: `frontend/src/__tests__/utils/aitoServices.test.ts` (create)

**Interfaces:**
- Consumes: `STAGES`, `taskCost` from `utils/aitoBoardRules`; `TaskDraft` from `utils/taskDraft`.
- Produces: `export interface StageWork { column: AitoColumnId; stepsDone: number; stepsTotal: number; value: number; valueDone: number }` and `export function stagesWithWork(tasks: readonly TaskDraft[]): StageWork[]`. Returns one entry per entry in `STAGES` (board order) that has at least one step; stages with no steps are omitted.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/utils/aitoServices.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stagesWithWork } from '../../components/aito/services';
import type { TaskDraft } from '../../utils/taskDraft';

/** A task carrying only the fields the rules read. `done` must list every
 *  service — the rule engine indexes it by ServiceId, not by presence. */
function task(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    id: null,
    uid: 'u1',
    title: '',
    description: '',
    scanCost: null,
    modelisationCost: null,
    impressionCost: null,
    usinageCost: null,
    done: { scan: false, modelisation: false, impression: false, usinage: false },
    ...overrides,
  } as TaskDraft;
}

describe('stagesWithWork', () => {
  it('omits a stage no task carries work for', () => {
    const result = stagesWithWork([task({ scanCost: 3500 })]);
    expect(result.map((s) => s.column)).toEqual(['scan']);
  });

  it('keeps board order regardless of which stages are present', () => {
    const result = stagesWithWork([task({ impressionCost: 100, scanCost: 200 })]);
    expect(result.map((s) => s.column)).toEqual(['scan', 'print']);
  });

  it('folds impression and usinage into the single print column', () => {
    const result = stagesWithWork([
      task({ impressionCost: 6000, usinageCost: 4000, done: { scan: false, modelisation: false, impression: true, usinage: false } }),
    ]);
    expect(result).toEqual([
      { column: 'print', stepsDone: 1, stepsTotal: 2, value: 10000, valueDone: 6000 },
    ]);
  });

  it('sums the same stage across several tasks', () => {
    const result = stagesWithWork([
      task({ uid: 'a', scanCost: 3500, done: { scan: true, modelisation: false, impression: false, usinage: false } }),
      task({ uid: 'b', scanCost: 1500 }),
    ]);
    expect(result).toEqual([
      { column: 'scan', stepsDone: 1, stepsTotal: 2, value: 5000, valueDone: 3500 },
    ]);
  });

  it('counts a step quoted free as a real step, not an absent one', () => {
    const result = stagesWithWork([task({ scanCost: 0 })]);
    expect(result).toEqual([
      { column: 'scan', stepsDone: 0, stepsTotal: 1, value: 0, valueDone: 0 },
    ]);
  });

  it('returns nothing for a project with no priced steps', () => {
    expect(stagesWithWork([task()])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/utils/aitoServices.test.ts`
Expected: FAIL — `stagesWithWork is not a function` / no export named `stagesWithWork`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/src/components/aito/services.ts`:

```ts
import { SERVICES, STAGES, taskCost } from '../../utils/aitoBoardRules';
import type { AitoColumnId } from '../../api/client';
```

(Extend the existing import from `aitoBoardRules` rather than adding a second one — it currently imports `SERVICES, taskCost`.)

```ts
/** What one work stage of the board still owes, summed over every task.
 *
 *  `stepsDone`/`stepsTotal` count (task, service) PAIRS: two tasks each
 *  carrying a scan is two steps. `value`/`valueDone` are the money those steps
 *  are quoted at, which is the number the panel's ring is weighted by — seven
 *  steps worth 3 500 to 10 000 FCFP each make "3/7" a poor proxy for progress.
 */
export interface StageWork {
  column: AitoColumnId;
  stepsDone: number;
  stepsTotal: number;
  value: number;
  valueDone: number;
}

/** A project's work, grouped by the board column that performs it.
 *
 *  The grouping comes from `STAGES`, which is the rule engine's own mapping and
 *  is pinned by the contract fixture — printing and machining are two steps on
 *  a task but one column on the board, so they sum into a single entry here.
 *  Read, never extended: adding to `aitoBoardRules` would desync the mirror.
 *
 *  Stages carrying no priced step are omitted rather than returned at zero. A
 *  project with no machining should not show an empty Machining row; `devis`,
 *  `waiting`, `finish` and `done` own no services at all and never appear. */
export function stagesWithWork(tasks: readonly TaskDraft[]): StageWork[] {
  return STAGES.flatMap(([column, services]) => {
    const entry: StageWork = { column, stepsDone: 0, stepsTotal: 0, value: 0, valueDone: 0 };
    for (const task of tasks) {
      for (const service of services) {
        const cost = taskCost(task, service);
        // null is "absent from the job"; 0 is "quoted free" and is a real step.
        if (cost === null) continue;
        entry.stepsTotal += 1;
        entry.value += cost;
        if (task.done[service]) {
          entry.stepsDone += 1;
          entry.valueDone += cost;
        }
      }
    }
    return entry.stepsTotal > 0 ? [entry] : [];
  });
}
```

`SERVICES` stays imported for the existing `taskSteps`; do not remove it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/utils/aitoServices.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/services.ts frontend/src/__tests__/utils/aitoServices.test.ts
git commit -m "feat(aito): group a project's work by the column that performs it"
```

---

### Task 2: Translations

Done before the components so nothing has to ship an English placeholder and come back for it. The parity gate rejects a non-English value identical to English, so every string below is a real translation.

**Files:**
- Modify: `frontend/src/i18n/locales/en.ts`, `de.ts`, `fr.ts`, `it.ts`, `ja.ts`, `pt-BR.ts`, `zh-CN.ts`, `zh-TW.ts`, `es.ts`, `ko.ts`, `ru.ts`, `tr.ts`, `uk.ts`

**Interfaces:**
- Produces: 15 keys under the existing `aito:` block. Later tasks call exactly these names.

Reused, do **not** re-add: `aito.productDescription`, `aito.sellerLabel`, `aito.createdLabel`, `aito.lastActivity`, `aito.quoteSearchLabel`, `aito.quoteOpenInZoho`, `aito.noClient`, `aito.addTask`, `aito.deleteTitle`, `aito.holdToDelete`, `aito.done`, `aito.markDone`, `aito.markNotDone`, `aito.progressLabel`, `aito.serviceScan3D`, `aito.serviceModelisation3D`, `aito.serviceImpression3D`, `aito.serviceUsinage`, `aito.columns.*`.

`aito.createdByLabel` becomes unused by the panel but stays in the locale files — the parity gate would fail on removing it from en alone, and removing it from all thirteen is unrelated churn. Leave it.

- [ ] **Step 1: Add the keys to `en.ts`**

Inside the `aito: {` block, after `lastActivity`:

```ts
      recordLabel: 'Record',
      stageAndWorkLeft: 'Stage & work left',
      workLabel: 'Work',
      moveToTrash: 'Move to trash',
      stepsCount: '{{done}}/{{total}} steps',
      amountDone: '{{amount}} done',
      workLeftAtStage: '{{amount}} left at {{stage}}',
      actorUnknown: 'unknown',
      actorUnknownUser: 'unknown user',
      actorClient: 'the client',
      actorAutomatic: 'automatic',
      lockQuote: 'Waiting for the quote to be accepted.',
      lockWaiting: 'Out with the client.',
      lockDeclined: 'The quote was declined.',
      lockSteps: 'Parked in {{stage}} until every {{stage}} step is ticked.',
```

- [ ] **Step 2: Add the same keys, translated, to the seven gated locales**

`de.ts`:
```ts
      recordLabel: 'Datensatz',
      stageAndWorkLeft: 'Phase & verbleibende Arbeit',
      workLabel: 'Arbeit',
      moveToTrash: 'In den Papierkorb',
      stepsCount: '{{done}}/{{total}} Schritte',
      amountDone: '{{amount}} erledigt',
      workLeftAtStage: '{{amount}} offen bei {{stage}}',
      actorUnknown: 'unbekannt',
      actorUnknownUser: 'unbekannter Benutzer',
      actorClient: 'der Kunde',
      actorAutomatic: 'automatisch',
      lockQuote: 'Wartet auf die Annahme des Angebots.',
      lockWaiting: 'Beim Kunden.',
      lockDeclined: 'Das Angebot wurde abgelehnt.',
      lockSteps: 'Bleibt in {{stage}}, bis jeder Schritt in {{stage}} abgehakt ist.',
```

`fr.ts`:
```ts
      recordLabel: 'Fiche',
      stageAndWorkLeft: 'Étape et travail restant',
      workLabel: 'Travail',
      moveToTrash: 'Mettre à la corbeille',
      stepsCount: '{{done}}/{{total}} étapes',
      amountDone: '{{amount}} fait',
      workLeftAtStage: '{{amount}} restant en {{stage}}',
      actorUnknown: 'inconnu',
      actorUnknownUser: 'utilisateur inconnu',
      actorClient: 'le client',
      actorAutomatic: 'automatique',
      lockQuote: 'En attente de l’acceptation du devis.',
      lockWaiting: 'Chez le client.',
      lockDeclined: 'Le devis a été refusé.',
      lockSteps: 'Reste en {{stage}} tant que chaque étape {{stage}} n’est pas cochée.',
```

`it.ts`:
```ts
      recordLabel: 'Scheda',
      stageAndWorkLeft: 'Fase e lavoro rimanente',
      workLabel: 'Lavoro',
      moveToTrash: 'Sposta nel cestino',
      stepsCount: '{{done}}/{{total}} passaggi',
      amountDone: '{{amount}} completato',
      workLeftAtStage: '{{amount}} rimanente in {{stage}}',
      actorUnknown: 'sconosciuto',
      actorUnknownUser: 'utente sconosciuto',
      actorClient: 'il cliente',
      actorAutomatic: 'automatico',
      lockQuote: 'In attesa dell’accettazione del preventivo.',
      lockWaiting: 'Dal cliente.',
      lockDeclined: 'Il preventivo è stato rifiutato.',
      lockSteps: 'Resta in {{stage}} finché ogni passaggio {{stage}} non è spuntato.',
```

`ja.ts`:
```ts
      recordLabel: '記録',
      stageAndWorkLeft: '工程と残作業',
      workLabel: '作業',
      moveToTrash: 'ゴミ箱に移動',
      stepsCount: '{{done}}/{{total}} ステップ',
      amountDone: '{{amount}} 完了',
      workLeftAtStage: '{{stage}} の残り {{amount}}',
      actorUnknown: '不明',
      actorUnknownUser: '不明なユーザー',
      actorClient: 'お客様',
      actorAutomatic: '自動',
      lockQuote: '見積書の承認待ちです。',
      lockWaiting: 'お客様の確認待ちです。',
      lockDeclined: '見積書は却下されました。',
      lockSteps: '{{stage}} のすべてのステップが完了するまで {{stage}} に留まります。',
```

`pt-BR.ts`:
```ts
      recordLabel: 'Registro',
      stageAndWorkLeft: 'Etapa e trabalho restante',
      workLabel: 'Trabalho',
      moveToTrash: 'Mover para a lixeira',
      stepsCount: '{{done}}/{{total}} etapas',
      amountDone: '{{amount}} concluído',
      workLeftAtStage: '{{amount}} restante em {{stage}}',
      actorUnknown: 'desconhecido',
      actorUnknownUser: 'usuário desconhecido',
      actorClient: 'o cliente',
      actorAutomatic: 'automático',
      lockQuote: 'Aguardando a aceitação do orçamento.',
      lockWaiting: 'Com o cliente.',
      lockDeclined: 'O orçamento foi recusado.',
      lockSteps: 'Fica em {{stage}} até que todas as etapas de {{stage}} sejam marcadas.',
```

`zh-CN.ts`:
```ts
      recordLabel: '记录',
      stageAndWorkLeft: '阶段与剩余工作',
      workLabel: '工作',
      moveToTrash: '移至回收站',
      stepsCount: '{{done}}/{{total}} 个步骤',
      amountDone: '已完成 {{amount}}',
      workLeftAtStage: '{{stage}} 还剩 {{amount}}',
      actorUnknown: '未知',
      actorUnknownUser: '未知用户',
      actorClient: '客户',
      actorAutomatic: '自动',
      lockQuote: '等待报价单被接受。',
      lockWaiting: '正在客户处等待。',
      lockDeclined: '报价单已被拒绝。',
      lockSteps: '在 {{stage}} 的所有步骤完成之前，将停留在 {{stage}}。',
```

`zh-TW.ts`:
```ts
      recordLabel: '紀錄',
      stageAndWorkLeft: '階段與剩餘工作',
      workLabel: '工作',
      moveToTrash: '移至垃圾桶',
      stepsCount: '{{done}}/{{total}} 個步驟',
      amountDone: '已完成 {{amount}}',
      workLeftAtStage: '{{stage}} 還剩 {{amount}}',
      actorUnknown: '未知',
      actorUnknownUser: '未知使用者',
      actorClient: '客戶',
      actorAutomatic: '自動',
      lockQuote: '等待報價單被接受。',
      lockWaiting: '正在客戶處等待。',
      lockDeclined: '報價單已被拒絕。',
      lockSteps: '在 {{stage}} 的所有步驟完成之前，將停留在 {{stage}}。',
```

- [ ] **Step 3: Add the keys to the five ungated locales**

`es.ts`, `ko.ts`, `ru.ts`, `tr.ts`, `uk.ts` are not covered by the parity script. Add the same 15 keys to each. Translate where you can; English is tolerated here because nothing enforces it. Use the `en.ts` block verbatim if you do not have the language.

- [ ] **Step 4: Run the gate**

Run: `cd frontend && npm run check:i18n`
Expected: exit 0, no diagnostic report. If it reports "identical to en", the offending locale still holds an English string — translate it rather than adding an allow-list entry.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/i18n/locales
git commit -m "i18n(aito): add the detail panel's stage rail and record copy"
```

---

### Task 3: Latest-event hook

The Record card's "last activity" actor. A dedicated one-row query, not a reuse of the `ActivityRail`'s pages — that list is filtered by the rail's depth toggle, so the name would change when the reader flipped Story/Detail/Everything.

**Files:**
- Create: `frontend/src/hooks/useLatestProjectEvent.ts`
- Test: `frontend/src/__tests__/hooks/useLatestProjectEvent.test.tsx` (create)

**Interfaces:**
- Consumes: `api.getAitoEvents` — `(projectId, { depth, cursor?, limit? }) => Promise<AitoEventPage>`, where `AitoEventPage` is `{ events: AitoEvent[]; has_more: boolean }`.
- Produces: `export function useLatestProjectEvent(projectId: number): { data: AitoEvent | undefined; isLoading: boolean }`. Query key `['aito-events', projectId, 'latest']` — sharing the `['aito-events', projectId]` prefix so the existing `invalidateQueries({ queryKey: ['aito-events', projectId] })` calls in `ActivityRail` and `ProjectDetailPanel` refresh it for free.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/hooks/useLatestProjectEvent.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useLatestProjectEvent } from '../../hooks/useLatestProjectEvent';
import { api } from '../../api/client';

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, api: { ...actual.api, getAitoEvents: vi.fn() } };
});

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const event = (overrides = {}) => ({
  id: 9,
  occurred_at: '2026-07-30T22:07:45',
  occurred_until: null,
  kind: 'quote.accepted',
  actor_class: 'user',
  actor_name: 'admin',
  subject_type: null,
  subject_id: null,
  subject_label: null,
  changes: null,
  detail: null,
  note: null,
  ...overrides,
});

describe('useLatestProjectEvent', () => {
  beforeEach(() => vi.mocked(api.getAitoEvents).mockReset());

  it('asks for one row at the deepest level, so the rail\'s depth toggle cannot change the answer', async () => {
    vi.mocked(api.getAitoEvents).mockResolvedValue({ events: [event()], has_more: true });

    const { result } = renderHook(() => useLatestProjectEvent(12), { wrapper });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(api.getAitoEvents).toHaveBeenCalledWith(12, { depth: 'everything', limit: 1 });
  });

  it('returns the single newest event', async () => {
    vi.mocked(api.getAitoEvents).mockResolvedValue({ events: [event({ actor_name: 'Zoho Books' })], has_more: true });

    const { result } = renderHook(() => useLatestProjectEvent(12), { wrapper });

    await waitFor(() => expect(result.current.data?.actor_name).toBe('Zoho Books'));
  });

  it('returns undefined for a project with no events at all', async () => {
    vi.mocked(api.getAitoEvents).mockResolvedValue({ events: [], has_more: false });

    const { result } = renderHook(() => useLatestProjectEvent(12), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/hooks/useLatestProjectEvent.test.tsx`
Expected: FAIL — cannot resolve `../../hooks/useLatestProjectEvent`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/hooks/useLatestProjectEvent.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { api, type AitoEvent } from '../api/client';

/** The single newest thing that happened to a project.
 *
 *  Exists because `AitoProject` snapshots a `created_by` and nothing equivalent
 *  for writes: there is no `updated_by` to read, and adding one would mean
 *  teaching every mutation path — description edits, task CRUD, the quote
 *  worker, the status reconciler — to write a column that would be null or
 *  "system" for most of them. The event log already answers this properly.
 *
 *  `depth: 'everything'` is required, not incidental. Reusing the pages
 *  `useProjectEvents` already holds would be free, but those are filtered by the
 *  ActivityRail's depth toggle — so the name in the Record card would silently
 *  change when the reader flipped Story/Detail/Everything.
 *
 *  Keyed under the `['aito-events', projectId]` prefix the note mutation and the
 *  description mutation already invalidate, so it refreshes with them. */
export function useLatestProjectEvent(projectId: number) {
  const query = useQuery({
    queryKey: ['aito-events', projectId, 'latest'],
    queryFn: () => api.getAitoEvents(projectId, { depth: 'everything', limit: 1 }),
  });

  return { data: query.data?.events[0] as AitoEvent | undefined, isLoading: query.isLoading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/hooks/useLatestProjectEvent.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useLatestProjectEvent.ts frontend/src/__tests__/hooks/useLatestProjectEvent.test.tsx
git commit -m "feat(aito): read the last activity's actor from the event log"
```

---

### Task 4: StageRail component

**Files:**
- Create: `frontend/src/components/aito/StageRail.tsx`
- Test: `frontend/src/__tests__/components/AitoStageRail.test.tsx` (create)

**Interfaces:**
- Consumes: `stagesWithWork` / `StageWork` (Task 1); `ALL_COLUMNS` and `ColumnMeta` from `./columns`; `Money` from `../calculator/shared`.
- Produces: `export function StageRail({ tasks, column, moveLock, currency }: { tasks: readonly TaskDraft[]; column: AitoColumnId; moveLock: AitoProject['move_lock']; currency: string })`.

**Note on colours:** `ColumnMeta.dot` is already a Tailwind background class (`bg-teal-400`, `bg-violet-400`, …). Use it directly for the node knob and the bar fill. The spec's Files table anticipated adding a raw colour export to `columns.ts`; it is not needed and `columns.ts` is not modified.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/__tests__/components/AitoStageRail.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StageRail } from '../../components/aito/StageRail';
import type { TaskDraft } from '../../utils/taskDraft';

function task(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    id: null, uid: 'u1', title: '', description: '',
    scanCost: null, modelisationCost: null, impressionCost: null, usinageCost: null,
    done: { scan: false, modelisation: false, impression: false, usinage: false },
    ...overrides,
  } as TaskDraft;
}

const tasks = [
  task({ uid: 'a', scanCost: 3500, modelisationCost: 4500, impressionCost: 10000,
         done: { scan: true, modelisation: true, impression: false, usinage: false } }),
];

describe('StageRail', () => {
  it('lists every board column, including the ones that own no work', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    ['Quote', 'Waiting', 'Scan', 'Modeling', 'Printing & Machining', 'Finish', 'Done'].forEach((label) =>
      expect(screen.getByText(label)).toBeInTheDocument(),
    );
  });

  it('is read-only — a column is derived, so nothing here is pressable', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('marks the current stage and reports progress for each stage that owns work', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.getByTestId('stage-node-scan')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('stage-node-devis')).toHaveAttribute('data-state', 'past');
    expect(screen.getByTestId('stage-node-print')).toHaveAttribute('data-state', 'future');
    expect(screen.getByTestId('stage-bar-scan')).toHaveStyle({ width: '100%' });
    expect(screen.getByTestId('stage-bar-print')).toHaveStyle({ width: '0%' });
  });

  it('renders no bar for a stage that owns no work', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.queryByTestId('stage-bar-finish')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stage-bar-model')).toBeInTheDocument();
  });

  it('explains why the card is parked, naming the stage', () => {
    render(<StageRail tasks={tasks} column="scan" moveLock="steps" currency="XPF" />);
    expect(screen.getByText(/Parked in Scan until every Scan step is ticked\./)).toBeInTheDocument();
  });

  it('explains each of the other locks', () => {
    const { rerender } = render(<StageRail tasks={tasks} column="devis" moveLock="quote" currency="XPF" />);
    expect(screen.getByText('Waiting for the quote to be accepted.')).toBeInTheDocument();

    rerender(<StageRail tasks={tasks} column="waiting" moveLock="waiting" currency="XPF" />);
    expect(screen.getByText('Out with the client.')).toBeInTheDocument();

    rerender(<StageRail tasks={tasks} column="done" moveLock="declined" currency="XPF" />);
    expect(screen.getByText('The quote was declined.')).toBeInTheDocument();
  });

  it('says nothing when the card is free to move', () => {
    render(<StageRail tasks={tasks} column="finish" moveLock={null} currency="XPF" />);
    expect(screen.queryByTestId('stage-lock')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoStageRail.test.tsx`
Expected: FAIL — cannot resolve `../../components/aito/StageRail`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/components/aito/StageRail.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { ALL_COLUMNS } from './columns';
import { stagesWithWork } from './services';
import { Money } from '../calculator/shared';
import type { AitoColumnId, AitoProject } from '../../api/client';
import type { TaskDraft } from '../../utils/taskDraft';

/** Explicit map rather than a template literal key: the i18n gate scans for
 *  literal `t('...')` calls, and a dynamic key is invisible to it. Same reason
 *  SYNC_LABEL_KEY in ProjectDetailPanel is written out. */
const LOCK_KEY: Record<string, string> = {
  quote: 'aito.lockQuote',
  waiting: 'aito.lockWaiting',
  declined: 'aito.lockDeclined',
  steps: 'aito.lockSteps',
};

export interface StageRailProps {
  tasks: readonly TaskDraft[];
  /** The project's CURRENT column, as derived by the rule engine. */
  column: AitoColumnId;
  moveLock: AitoProject['move_lock'];
  currency: string;
}

/** Where the project has got to, and what each stage still owes.
 *
 *  READ-ONLY BY CONSTRUCTION — no button, no handler, no mutation. A column is
 *  derived by the board rule engine (`evaluate` in utils/aitoBoardRules.ts) from
 *  the quote status and the services with unticked steps; the only manual
 *  transition in the whole model is Finish <-> Done, and that lives on the card.
 *  A pressable stage here would have to either no-op or fight the engine.
 *
 *  It replaces a 2px dot at the foot of a spec sheet, and it answers a question
 *  no surface answered before: not just where the card is, but what has to
 *  happen before it moves. */
export function StageRail({ tasks, column, moveLock, currency }: StageRailProps) {
  const { t } = useTranslation();
  const work = stagesWithWork(tasks);
  const currentIndex = ALL_COLUMNS.findIndex((c) => c.id === column);
  const lockKey = moveLock ? LOCK_KEY[moveLock] : null;
  const currentLabel = currentIndex >= 0 ? t(ALL_COLUMNS[currentIndex].labelKey) : column;

  return (
    <div>
      <ol>
        {ALL_COLUMNS.map((meta, index) => {
          const stage = work.find((w) => w.column === meta.id);
          const state = index < currentIndex ? 'past' : index === currentIndex ? 'current' : 'future';
          const percent = stage && stage.stepsTotal > 0 ? (stage.stepsDone / stage.stepsTotal) * 100 : 0;

          return (
            <li
              key={meta.id}
              data-testid={`stage-node-${meta.id}`}
              data-state={state}
              className="relative grid grid-cols-[0.75rem_minmax(0,1fr)] gap-2.5 pb-3 last:pb-0"
            >
              {/* The connector runs from this node to the next. `past` is the
                  travelled path and takes the accent; everything ahead stays
                  the neutral track colour. Hidden on the last row, which has
                  nothing below it to connect to. */}
              <span
                aria-hidden="true"
                className={`absolute left-[0.28rem] top-4 bottom-0 w-0.5 last:hidden ${
                  state === 'past' ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'
                } ${index === ALL_COLUMNS.length - 1 ? 'hidden' : ''}`}
              />
              <span
                aria-hidden="true"
                className={`mt-1.5 w-2.5 h-2.5 rounded-full transition-transform duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                  state === 'future' ? 'bg-bambu-dark-tertiary' : state === 'past' ? 'bg-bambu-green' : `${meta.dot} scale-125`
                }`}
              />
              <span className="min-w-0">
                <span
                  className={`text-sm block ${
                    state === 'current' ? 'text-white font-medium' : state === 'past' ? 'text-bambu-gray-light' : 'text-bambu-gray'
                  }`}
                >
                  {t(meta.labelKey)}
                </span>
                {stage && (
                  <span className="flex items-center gap-1.5 mt-1">
                    <span
                      role="progressbar"
                      aria-valuenow={stage.stepsDone}
                      aria-valuemin={0}
                      aria-valuemax={stage.stepsTotal}
                      aria-label={t('aito.workLeftAtStage', {
                        amount: `${stage.value - stage.valueDone}`,
                        stage: t(meta.labelKey),
                      })}
                      className="flex-1 h-0.5 rounded-full bg-bambu-dark-tertiary overflow-hidden"
                    >
                      <span
                        data-testid={`stage-bar-${meta.id}`}
                        style={{ width: `${percent}%` }}
                        className={`block h-full rounded-full ${meta.dot} transition-[width] duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none`}
                      />
                    </span>
                    <Money
                      currency={currency}
                      value={stage.value - stage.valueDone}
                      className="text-xs text-bambu-gray flex-shrink-0"
                    />
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

      {lockKey && (
        <p
          data-testid="stage-lock"
          className="text-xs text-bambu-gray border-t border-bambu-dark-tertiary mt-1 pt-2"
        >
          {t(lockKey, { stage: currentLabel })}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoStageRail.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/StageRail.tsx frontend/src/__tests__/components/AitoStageRail.test.tsx
git commit -m "feat(aito): say where a project is and what is left before it moves"
```

---

### Task 5: Row-wide step toggle

The most-pressed control in the panel is currently a 60×20px pill. It becomes the row.

**Files:**
- Modify: `frontend/src/components/aito/TaskStepList.tsx`
- Test: `frontend/src/__tests__/components/AitoTaskStepList.test.tsx` (modify)

**Interfaces:**
- Consumes: `taskSteps`, `AITO_SERVICE_LABEL_KEYS` from `./services`; `STAGES` from `utils/aitoBoardRules` (for the swatch colour); `ALL_COLUMNS` from `./columns`.
- Produces: no signature change. `TaskStepListProps` stays `{ task, onChange, canTick }`.

- [ ] **Step 1: Read the existing test, then add the new cases**

Open `frontend/src/__tests__/components/AitoTaskStepList.test.tsx` (71 lines). Keep every existing assertion about `canTick` and about a ticked step rendering ticked. Add:

```tsx
  it('makes the whole row the toggle, not just a pill at its end', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskStepList task={task({ scanCost: 3500 })} onChange={onChange} canTick />);

    // The accessible name is the row's, and pressing anywhere in it ticks.
    const row = screen.getByRole('button', { name: /Scan/ });
    await user.click(row);

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ done: expect.objectContaining({ scan: true }) }),
    );
  });

  it('gives the row a checkbox-style pressed state rather than a Done label', async () => {
    render(<TaskStepList task={task({ scanCost: 3500 })} onChange={vi.fn()} canTick />);
    expect(screen.getByRole('button', { name: /Scan/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('colours each step by the board stage that performs it', () => {
    render(
      <TaskStepList
        task={task({ scanCost: 3500, modelisationCost: 4500, impressionCost: 1000, usinageCost: 2000 })}
        onChange={vi.fn()}
        canTick
      />,
    );
    expect(screen.getByTestId('step-swatch-scan')).toHaveClass('bg-teal-400');
    expect(screen.getByTestId('step-swatch-modelisation')).toHaveClass('bg-violet-400');
    // Printing and machining share the print column, so they share its colour.
    expect(screen.getByTestId('step-swatch-impression')).toHaveClass('bg-orange-400');
    expect(screen.getByTestId('step-swatch-usinage')).toHaveClass('bg-orange-400');
  });

  it('still renders a step with no toggle when the quote is not accepted', () => {
    render(<TaskStepList task={task({ scanCost: 3500 })} onChange={vi.fn()} canTick={false} />);
    expect(screen.getByText('Scan')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
```

If the existing file lacks a `task()` factory, add the same one used in Task 1's test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoTaskStepList.test.tsx`
Expected: FAIL — no button with the row's name / `step-swatch-scan` not found.

- [ ] **Step 3: Rewrite the list body**

In `frontend/src/components/aito/TaskStepList.tsx`, add above the component:

```tsx
import { STAGES } from '../../utils/aitoBoardRules';
import { ALL_COLUMNS } from './columns';
import type { ServiceId } from '../../utils/aitoBoardRules';

/** The board column that performs a service, and therefore the colour the step
 *  wears. Built from STAGES so it can never disagree with the rule engine about
 *  which column a service belongs to — impression and usinage both map to
 *  `print`, which is why they share an accent. */
const STAGE_DOT: Record<string, string> = Object.fromEntries(
  STAGES.flatMap(([column, services]) =>
    services.map((service: ServiceId) => [service, ALL_COLUMNS.find((c) => c.id === column)?.dot ?? '']),
  ),
);
```

Replace the `<ul>` body with:

```tsx
  return (
    <ul className="space-y-0.5">
      {steps.map(({ service, cost, done }) => {
        const label = t(AITO_SERVICE_LABEL_KEYS[service]);
        const row = (
          <>
            {/* The checkbox IS the affordance now. The old design put a "Done"
                pill at the end of the row, which named the action but gave it
                the smallest target in the panel. */}
            {canTick && (
              <span
                aria-hidden="true"
                className={`w-4 h-4 flex-shrink-0 rounded grid place-items-center border transition-colors duration-200 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                  done
                    ? 'bg-bambu-green border-bambu-green text-bambu-dark'
                    : 'border-bambu-dark-tertiary text-transparent group-hover/step:border-bambu-green'
                }`}
              >
                {done && <Check className="w-3 h-3 animate-tick-in" />}
              </span>
            )}
            <span
              data-testid={`step-swatch-${service}`}
              aria-hidden="true"
              className={`w-0.5 h-4 flex-shrink-0 rounded-full ${STAGE_DOT[service]} transition-opacity duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'opacity-30' : ''
              }`}
            />
            <span
              className={`text-sm flex-1 min-w-0 truncate text-left transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'text-bambu-gray' : 'text-white'
              }`}
            >
              {label}
            </span>
            <Money
              currency={currency}
              value={cost}
              className={`text-sm flex-shrink-0 transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'text-bambu-gray' : 'text-white'
              }`}
            />
          </>
        );

        return (
          <li key={service}>
            {canTick ? (
              <button
                type="button"
                aria-pressed={done}
                onClick={() => onChange({ ...task, done: { ...task.done, [service]: !done } })}
                className={`group/step w-full flex items-center gap-3 rounded-md px-1.5 py-1 -mx-1.5 transition-colors hover:bg-white/[0.045] ${focusRingCls}`}
              >
                {row}
              </button>
            ) : (
              // No toggle at all before the quote is accepted — there is no
              // authorised work to tick, so an inert control would explain
              // nothing. The step and its price still render.
              <span className="w-full flex items-center gap-3 px-1.5 py-1 -mx-1.5">{row}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
```

The `aria-label`/`aria-pressed` pair replaces the old `markDone`/`markNotDone` labels: the button's accessible name is now the step's own text, and `aria-pressed` carries the state. Remove the `t('aito.markDone')` / `t('aito.markNotDone')` calls and the `t('aito.done')` pill label from this file. **Do not delete those keys from the locale files** — `TaskStepList` is not their only caller; verify with `rg "aito.markDone|aito.done'" frontend/src` before touching any locale.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoTaskStepList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/TaskStepList.tsx frontend/src/__tests__/components/AitoTaskStepList.test.tsx
git commit -m "feat(aito): make the step row itself the Done target"
```

---

### Task 6: Per-task progress

**Files:**
- Modify: `frontend/src/components/aito/TaskRow.tsx`
- Test: `frontend/src/__tests__/components/AitoTaskRow.test.tsx` (modify)

**Interfaces:**
- Consumes: `taskSteps`, `isTaskFinished` from `./services`; `ProjectProgress` from `./ProjectProgress`.
- Produces: no prop change.

`ProjectProgress` already renders nothing at `total <= 0` and already carries the width transition. Reuse it rather than writing a second bar — but it hard-codes `data-testid="aito-progress-fill"`, and the panel will now hold several. Add an optional `testId` prop defaulting to the existing value so the card's own bar is unaffected.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/__tests__/components/AitoTaskRow.test.tsx`:

```tsx
  it('shows how far through its own steps the task is', () => {
    render(
      <TaskRow
        task={task({
          scanCost: 3500, modelisationCost: 4500, impressionCost: 10000,
          done: { scan: true, modelisation: false, impression: false, usinage: false },
        })}
        index={0}
        onChange={vi.fn()}
        editing={false}
        onToggleEdit={vi.fn()}
        canTick
      />,
    );
    expect(screen.getByText('1/3 steps')).toBeInTheDocument();
    expect(screen.getByTestId('task-progress-0')).toHaveStyle({ width: '33%' });
  });

  it('renders no progress for a task with no priced steps', () => {
    render(
      <TaskRow task={task()} index={0} onChange={vi.fn()} editing={false} onToggleEdit={vi.fn()} canTick />,
    );
    expect(screen.queryByTestId('task-progress-0')).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoTaskRow.test.tsx`
Expected: FAIL — `1/3 steps` not found.

- [ ] **Step 3: Add the `testId` prop to `ProjectProgress`, then use it**

In `frontend/src/components/aito/ProjectProgress.tsx`, change the signature and the fill:

```tsx
export function ProjectProgress({
  done,
  total,
  /** Defaults to the board card's id so existing callers and their tests are
   *  untouched; the detail panel passes one per task, since a page holding
   *  several bars cannot share a single testid. */
  testId = 'aito-progress-fill',
}: {
  done: number;
  total: number;
  testId?: string;
}) {
```

and `data-testid={testId}` on the fill div.

In `frontend/src/components/aito/TaskRow.tsx`, inside the header `<h4>` after the name and before `Money`:

```tsx
          {steps.length > 0 && (
            <span className="text-xs text-bambu-gray flex-shrink-0 tabular-nums">
              {t('aito.stepsCount', { done: steps.filter((s) => s.done).length, total: steps.length })}
            </span>
          )}
```

and immediately after the closing `</div>` of the header row, before `<div className="px-3 pb-3 space-y-3">`:

```tsx
      {/* The task's own progress, under its header. `ProjectProgress` renders
          nothing at zero steps, so an unpriced row shows no empty track. */}
      <div className="px-3 pb-2">
        <ProjectProgress
          done={steps.filter((s) => s.done).length}
          total={steps.length}
          testId={`task-progress-${index}`}
        />
      </div>
```

Import `ProjectProgress` at the top.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/components/AitoTaskRow.test.tsx src/__tests__/components/AitoDoneGrid.test.tsx`
Expected: PASS. The second file is included because it renders board cards that use `ProjectProgress` with the default testid — it must stay green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/TaskRow.tsx frontend/src/components/aito/ProjectProgress.tsx frontend/src/__tests__/components/AitoTaskRow.test.tsx
git commit -m "feat(aito): show each task's own progress on its header"
```

---

### Task 7: Panel header

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx:243-261` (the header block)
- Test: `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx` (modify)

**Interfaces:**
- Consumes: `stagesWithWork` (Task 1) for the value-weighted ring; the existing `CopyableValue`.
- Produces: local `ValueRing({ done, total })` and `PanelHeader({ project, currency })` — not exported.

**Existing tests this inverts.** These currently assert the old hierarchy and must be rewritten, not deleted:
- `titles the panel with the project reference, not the client` (line ~203) — the heading is now the client.
- `labels a company client as Company name` / `labels a person client as Client name` / `labels a legacy card with a null flag as Client name` (~215-229) — the `Company name:` / `Client name:` `<dt>`s are gone; the client is the title. Keep the `client_is_company` distinction only if it still has a visible effect; if it does not, delete those three tests and say so in the commit message.
- `labels the phone and email, and copies rather than dialling them` (~232) — the `Phone:` label is gone; the copy behaviour is not. Keep every copy assertion, drop the label one.
- `right-aligns the metadata values` (~1099) — the `<dl>` is gone.

- [ ] **Step 1: Rewrite the header tests**

```tsx
  it('titles the panel with the client, and keeps the project reference as its eyebrow', () => {
    renderPanel();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('ACME SARL');
    expect(screen.getByText(/Project #12|Projet n°12/)).toBeInTheDocument();
  });

  it('falls back to the no-client label when the card has none', () => {
    renderPanel({ client_name: null });
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/no client/i);
  });

  it('still names the dialog after the client for assistive technology', () => {
    renderPanel();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ACME SARL');
  });

  it('weights the header ring by money rather than by step count', async () => {
    // 3 500 of 18 000 done is 1 of 3 steps: 19%, not 33%.
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('panel-value-ring')).toBeInTheDocument());
    expect(screen.getByTestId('panel-value-ring')).toHaveAttribute('aria-valuenow', '3500');
    expect(screen.getByTestId('panel-value-ring')).toHaveAttribute('aria-valuemax', '18000');
  });
```

Adjust the fixture amounts to whatever `renderPanel`'s existing project/tasks mocks use — read them first and make the assertion match, rather than changing the fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx -t "titles the panel"`
Expected: FAIL — heading has "Project #12", not "ACME SARL".

- [ ] **Step 3: Replace the header block**

Add above the component in `ProjectDetailPanel.tsx`:

```tsx
/** Money done over money quoted, as a ring.
 *
 *  Deliberately not the step count the card's bar uses. Seven steps on a
 *  typical project are worth between 3 500 and 10 000 FCFP each, so "3/7" and
 *  "how much of this job is done" are different numbers; the line beneath the
 *  ring gives both so neither reading is lost. */
function ValueRing({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation();
  const size = 42;
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? done / total : 0;

  return (
    <svg
      data-testid="panel-value-ring"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-label={t('aito.amountDone', { amount: `${done}` })}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90 flex-shrink-0"
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={3} className="stroke-bambu-dark-tertiary" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        className="stroke-bambu-green transition-[stroke-dashoffset] duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none"
      />
    </svg>
  );
}
```

Replace lines 243-261 with:

```tsx
        <div
          className="flex-shrink-0 px-5 py-4 flex items-center gap-5 border-b"
          style={{
            // 135deg, not 180: on a ~1200x90 band a diagonal axis reads as a
            // near-horizontal fade, so the wash sits behind the client name and
            // clears before the total. The vertical version tints the top of
            // the band — where the small grey eyebrow lives — and casts over the
            // one number that must not compete with a colour.
            backgroundImage:
              'linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, var(--bg-secondary)), var(--bg-secondary))',
            borderBottomColor: 'color-mix(in srgb, var(--accent) 40%, var(--border-color))',
          }}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs uppercase tracking-wide text-bambu-gray">
                {t('aito.projectRef', { id: project.id })}
              </span>
              {project.quote_number && (
                <>
                  <span className="text-xs text-bambu-gray opacity-50">·</span>
                  {project.quote_url ? (
                    <a
                      href={project.quote_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t('aito.quoteOpenInZoho')}
                      className="text-xs uppercase tracking-wide text-bambu-green hover:text-bambu-green/80 inline-flex items-center gap-1"
                    >
                      {project.quote_number}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="text-xs uppercase tracking-wide text-bambu-gray">{project.quote_number}</span>
                  )}
                </>
              )}
            </div>
            <h2 className="text-xl font-semibold text-white truncate">
              {project.client_name ?? t('aito.noClient')}
            </h2>
            <div className="flex items-center gap-4 mt-1 text-sm">
              {project.client_phone && <CopyableValue value={project.client_phone} label={t('aito.phoneLabel')} />}
              {project.client_email && <CopyableValue value={project.client_email} label={t('aito.emailLabel')} />}
            </div>
          </div>

          <div className="w-px self-stretch bg-bambu-dark-tertiary" />

          <div className="flex items-center gap-3 flex-shrink-0">
            <ValueRing done={valueDone} total={valueTotal} />
            <div className="text-right">
              <Money currency={currency} value={valueTotal} className="block text-2xl font-semibold text-white" />
              <span className="block text-xs text-bambu-gray tabular-nums">
                {t('aito.amountDone', { amount: '' })} {/* see below */}
              </span>
            </div>
          </div>
        </div>
```

For the sub-line, compose it from the two existing keys rather than inventing a third:

```tsx
              <span className="block text-xs text-bambu-gray tabular-nums">
                {t('aito.amountDone', { amount: formatMoney(valueDone, currency) })}
                {' · '}
                {t('aito.stepsCount', { done: project.steps_done, total: project.steps_total })}
              </span>
```

`Money` is a component, so the `amountDone` interpolation needs a plain string. Use the same formatter `Money` uses — read `components/calculator/shared.tsx` and export its internal formatter if it is not already exported, rather than writing a second one.

Derive the totals near the top of the component body, after `tasks` comes from `useProjectTasks`:

```tsx
  const stageWork = stagesWithWork(tasks);
  const valueTotal = stageWork.reduce((sum, s) => sum + s.value, 0);
  const valueDone = stageWork.reduce((sum, s) => sum + s.valueDone, 0);
```

and get `currency` the same way `TaskRow` does — the `['settings']` query with `staleTime: 60_000`, so it rides the existing cache rather than adding a fetch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx`
Expected: PASS for the header tests. Other tests in this file will still fail — Tasks 8 and 9 fix them. Do not proceed until the header ones are green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/__tests__/components/ProjectDetailPanel.test.tsx
git commit -m "feat(aito): give the panel the client's name and the job's value"
```

---

### Task 8: Left column — four cards

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx:291-502` (the left column)
- Test: `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx` (modify)

**Interfaces:**
- Consumes: `StageRail` (Task 4), `useLatestProjectEvent` (Task 3).
- Produces: local `RecordCard({ project, latestEvent })`.

**Existing tests this changes:** `still labels the column of a done project` (~1378) — the `Stage:` row is gone; assert the rail marks `done` as current instead.

- [ ] **Step 1: Write the failing tests**

```tsx
  it('groups the left column into four cards, description first', () => {
    renderPanel();
    const headings = screen.getAllByTestId('panel-card-heading').map((n) => n.textContent);
    expect(headings).toEqual(['Product description', 'Stage & work left', 'Quote', 'Record']);
  });

  it('folds the creator into the created timestamp', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('record-created')).toBeInTheDocument());
    expect(screen.getByTestId('record-created')).toHaveTextContent('· admin');
    expect(screen.queryByText(/^created by/i)).not.toBeInTheDocument();
  });

  it('says the creator is unknown rather than trailing off', async () => {
    renderPanel({ created_by: null });
    await waitFor(() => expect(screen.getByTestId('record-created')).toHaveTextContent(/· unknown/));
  });

  it('takes both halves of last activity from the newest event', async () => {
    // occurred_at and the actor belong together; updated_at paired with the
    // newest actor's name would describe two different moments.
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('record-activity')).toHaveTextContent('· admin'));
  });

  it('falls back to updated_at with no actor when the project has no events', async () => {
    // A card created before the history feature landed.
    server.use(http.get('*/aito/12/events', () => HttpResponse.json({ events: [], has_more: false })));
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('record-activity')).toBeInTheDocument());
    expect(screen.getByTestId('record-activity')).not.toHaveTextContent('·');
  });

  it('marks a done project current on the rail', () => {
    renderPanel({ column: 'done', move_lock: null });
    expect(screen.getByTestId('stage-node-done')).toHaveAttribute('data-state', 'current');
  });
```

Match the mock-server import style already used in this file — read its top 60 lines first; it may use `vi.mock` on `api` rather than MSW.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx -t "four cards"`
Expected: FAIL — no `panel-card-heading` nodes.

- [ ] **Step 3: Implement**

Add a local card wrapper above the component:

```tsx
/** One group of the left rail. `bg-bambu-dark-secondary` with a border and NO
 *  shadow: only the task cards cast one, so the column the operator works in
 *  stays the front plane. Spreading the shadow over every group is what makes
 *  the task list stop being the focus. */
function PanelCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3">
      <p data-testid="panel-card-heading" className="text-xs uppercase tracking-wide text-bambu-gray mb-2">
        {title}
      </p>
      {children}
    </section>
  );
}
```

and the record card:

```tsx
/** Explicit map, same reason as SYNC_LABEL_KEY: a dynamic key is invisible to
 *  the i18n gate's literal scan. */
const ACTOR_FALLBACK_KEY: Record<string, string> = {
  user: 'aito.actorUnknownUser',
  client: 'aito.actorClient',
  system: 'aito.actorAutomatic',
};

function RecordCard({ project, latestEvent }: { project: AitoProject; latestEvent: AitoEvent | undefined }) {
  const { t, i18n } = useTranslation();
  const created = parseUTCDate(project.created_at);
  // Both halves from the same event. A mirrored Zoho comment carries Books'
  // timestamp rather than ours — which is exactly why occurred_at is stored
  // apart from created_at — so pairing updated_at with this actor's name would
  // produce a line whose time and name describe different things.
  const activityAt = latestEvent ? parseUTCDate(latestEvent.occurred_at) : parseUTCDate(project.updated_at);
  const actor = latestEvent
    ? latestEvent.actor_name ?? t(ACTOR_FALLBACK_KEY[latestEvent.actor_class] ?? 'aito.actorUnknown')
    : null;

  // Short, not the bare toLocaleString the old rows used: "{when} · {who}" has
  // to fit one line of a 17rem rail. The exact timestamps stay in the timeline.
  const short = (d: Date | null) =>
    d ? d.toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <PanelCard title={t('aito.recordLabel')}>
      <dl className="grid gap-0.5">
        {project.quote_salesperson && (
          <>
            <dt className="text-xs text-bambu-gray opacity-80">{t('aito.sellerLabel')}</dt>
            <dd className="text-sm text-bambu-gray-light mb-2">{project.quote_salesperson}</dd>
          </>
        )}
        <dt className="text-xs text-bambu-gray opacity-80">{t('aito.createdLabel')}</dt>
        <dd data-testid="record-created" className="text-sm text-bambu-gray-light mb-2">
          {short(created)} · {project.created_by ?? t('aito.actorUnknown')}
        </dd>
        <dt className="text-xs text-bambu-gray opacity-80">{t('aito.lastActivity')}</dt>
        <dd data-testid="record-activity" className="text-sm text-bambu-gray-light">
          {short(activityAt)}
          {actor && ` · ${actor}`}
        </dd>
      </dl>
    </PanelCard>
  );
}
```

In the panel body, replace the left column's contents with, in order: the description `PanelCard` (keeping the existing editing behaviour verbatim), a `PanelCard` holding `<StageRail tasks={tasks} column={project.column} moveLock={project.move_lock} currency={currency} />`, a `PanelCard` for the quote rows, the full-width sync / status-block / declined rows **unchanged**, then `<RecordCard />`, then `<QuoteStatusActions project={project} />`.

Call the hook near the other hooks: `const { data: latestEvent } = useLatestProjectEvent(project.id);`

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx`
Expected: PASS except the footer/focus tests, which Task 9 fixes.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/__tests__/components/ProjectDetailPanel.test.tsx
git commit -m "feat(aito): group the panel's record into four cards"
```

---

### Task 9: Footer bar, no close button, focus

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx` (header actions, new footer, dialog focus)
- Test: `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx` (modify)

**Interfaces:**
- Consumes: `DeleteHoldButton`, `QuotePrintButton`.

- [ ] **Step 1: Write the failing tests**

```tsx
  it('has no close button — outside-click and Escape are the ways out', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('focuses the dialog itself on open, so Escape and Tab start inside it', () => {
    renderPanel();
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('still closes on Escape', async () => {
    const onClose = vi.fn();
    render(<ProjectDetailPanel project={project} onClose={onClose} onDelete={vi.fn()} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('puts the destructive action in the footer, opposite the safe ones', () => {
    renderPanel();
    const footer = screen.getByTestId('panel-footer');
    expect(within(footer).getByRole('button', { name: /move to trash|delete project/i })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: /print/i })).toBeInTheDocument();
  });

  it('omits the trash control for a project already in the trash', () => {
    render(<ProjectDetailPanel project={project} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /move to trash|delete project/i })).not.toBeInTheDocument();
  });
```

Keep the existing `offers delete in the expanded card, on a 1s hold` test (~1345) and update only its query to look inside `panel-footer`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx -t "no close button"`
Expected: FAIL — a close button is still rendered.

- [ ] **Step 3: Implement**

Delete the `closeRef` button and the `<X>` import if unused elsewhere. Replace the focus effect:

```tsx
  const dialogRef = useRef<HTMLDivElement>(null);

  // The close button used to take focus on mount. Without it, focus would stay
  // on whatever was behind the dialog: Escape still works (the handler is on
  // window) but Tab order would start outside the modal and a screen reader
  // would announce nothing on open. The dialog takes it instead — it already
  // carries role/aria-modal/aria-label, so focusing it announces the panel by
  // its client name.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
```

Put `ref={dialogRef}` and `tabIndex={-1}` on the dialog div, and add `focus:outline-none` so the programmatic focus does not draw a ring.

Add the footer as the last child of the dialog, after the body:

```tsx
        <div
          data-testid="panel-footer"
          className="flex-shrink-0 flex items-center gap-2 px-4 py-2 border-t border-bambu-dark-tertiary bg-black/10"
        >
          {/* Destructive far left, safe actions far right — the two ends of the
              bar. This is what the header adjacency to Close cost us. */}
          {onDelete && (
            <DeleteHoldButton onDelete={onDelete} label={t('aito.moveToTrash')} hint={t('aito.holdToDelete')} />
          )}
          <span className="flex-1" />
          <QuotePrintButton project={project} />
          {project.quote_url && (
            <a
              href={project.quote_url}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-2.5 py-1 text-sm text-bambu-gray-light hover:text-white hover:border-bambu-gray transition-colors ${focusRingCls}`}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {t('aito.quoteOpenInZoho')}
            </a>
          )}
        </div>
```

Remove `QuotePrintButton` from the quote card in Task 8's markup — it lives in the footer now, not both places.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/aito/ProjectDetailPanel.tsx frontend/src/__tests__/components/ProjectDetailPanel.test.tsx
git commit -m "feat(aito): move delete off the close button and into a footer"
```

---

### Task 10: Surfaces

Last, because it touches only class names and is easiest to review against a working panel.

**Files:**
- Modify: `frontend/src/components/aito/ProjectDetailPanel.tsx` (panel, columns, task cards)
- Test: `frontend/src/__tests__/components/ProjectDetailPanel.test.tsx` (modify the four layout tests, ~1364-1458)

- [ ] **Step 1: Update the layout tests**

The existing tests at ~1364 (`separates the left column from the tasks on wide screens`), ~1414 (`caps the panel at the viewport`), ~1421 (`turns the body into a non-scrolling flex column`), ~1430 (`gives every grid column its own scroller`) and ~1451 (`keeps the body a shrinkable flex child`) all assert on class names that change. Read each, keep its *intent*, and update the expected classes. Add:

```tsx
  it('ranks elevation: only the task cards cast a shadow', () => {
    renderPanel();
    expect(screen.getByTestId('panel-column-tasks')).toBeInTheDocument();
    // Reference cards carry a border and no shadow.
    const referenceCard = screen.getAllByTestId('panel-card-heading')[0].parentElement!;
    expect(referenceCard.className).toContain('border-bambu-dark-tertiary');
    expect(referenceCard.className).not.toContain('card-shadow');
  });

  it('puts the body on the canvas tier, not the panel tier', () => {
    renderPanel();
    expect(screen.getByRole('dialog').className).toContain('bg-bambu-dark');
    expect(screen.getByRole('dialog').className).not.toContain('bg-bambu-dark-secondary');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/__tests__/components/ProjectDetailPanel.test.tsx -t "canvas tier"`
Expected: FAIL — the dialog is still `bg-bambu-dark-secondary`.

- [ ] **Step 3: Apply the surfaces**

- Dialog: `bg-bambu-dark-secondary` → `bg-bambu-dark`. The body is canvas; the header, footer and cards sit on it as `bg-bambu-dark-secondary`. This is the whole contrast effect and it needs no new colour — the app's two background tiers already mean exactly this, in every palette and in light mode.
- Body grid: move the padding off the body and onto each column, so a column's background covers its full height. Each column: `min-h-0 overflow-y-auto scrollbar-hide px-5 py-4`. Give the middle column `data-testid="panel-column-tasks"`.
- Drop the `lg:border-l lg:border-bambu-dark-tertiary` separators between columns; the surface change now does that work.
- Task cards, in `TaskRow.tsx`: add `bg-bambu-dark-secondary card-shadow` to the root div. `.card-shadow` is an existing utility bound to `var(--card-shadow)`, which is already redefined per light/dark **and** per style effect — a `style-glow` user keeps their accent halo for free.
- Reference cards keep border-only, no shadow (already the case from Task 8's `PanelCard`).

Do **not** add an accent glow to the panel border. It was tried in the mockups: behind the `black/70` backdrop it is invisible at every strength short of garish, and the lift comes from the canvas contrast and the header's cast shadow.

- [ ] **Step 4: Run the full frontend suite**

Run from project root: `./test_frontend.sh`
Expected: tsc clean, ESLint clean, all Vitest green, `check:i18n` exit 0.

- [ ] **Step 5: Verify the build and commit**

```bash
cd frontend && npm run build && cd ..
git add frontend/src/components/aito
git commit -m "feat(aito): rank the panel's elevation so the task column leads"
```

---

## Self-Review

**Spec coverage.** Header → Task 7. Stage rail → Tasks 1 and 4. Left column four cards → Task 8. Who-after-the-when → Tasks 3 and 8. Task column → Tasks 5 and 6. Footer bar → Task 9. Focus → Task 9. Surfaces → Task 10. Motion → carried inside Tasks 4-7 and 10 as `motion-reduce:` variants. i18n → Task 2.

**Two divergences from the spec, both deliberate:**
1. The spec's Files table lists a `columns.ts` change to export a raw stage colour. Not needed — `ColumnMeta.dot` is already a Tailwind background class and serves the rail knob, the rail bar and the step swatch directly. `columns.ts` is untouched.
2. The spec did not anticipate `ProjectProgress`'s hard-coded `data-testid`. Task 6 adds an optional `testId` prop, defaulted so board-card callers and their tests are unaffected.

**Placeholder scan.** No TBD/TODO. Every code step carries real code. Two steps deliberately say "read the existing file first" rather than quoting it — Task 7 step 1 (the test fixture's amounts) and Task 8 step 1 (the mocking style). Those are lookups, not decisions.

**Type consistency.** `stagesWithWork` returns `StageWork[]` with `stepsDone`/`stepsTotal`/`value`/`valueDone` — used with those exact names in Tasks 4, 7 and 8. `useLatestProjectEvent` returns `{ data, isLoading }`, destructured as `data: latestEvent` in Task 8. `ProjectProgress`'s new prop is `testId` in both Task 6 sites.

**Known risk not yet resolved.** `ProjectDetailPanel.test.tsx` is 1458 lines and roughly eight of its tests assert the old hierarchy. Tasks 7-10 each rewrite the ones they invalidate, but the file will be red between tasks. That is expected; the gate is that the whole file is green at the end of Task 9 and the whole suite at the end of Task 10.
