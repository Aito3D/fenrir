# Shell Intro Gating + Page Crossfade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app-shell intro plays only after login and on real page loads (never on internal navigation), and page changes crossfade via native View Transitions instead of cutting.

**Architecture:** A module-scope flag in Layout.tsx gates every intro class; LoginPage re-arms it. Sidebar NavLinks and the 1–9 keyboard shortcuts opt into React Router v7's `viewTransition`; AnimatedOutlet feature-detects `document.startViewTransition` and drops its own entrance when the browser crossfades instead.

**Tech Stack:** React 19, React Router 7.16 (`viewTransition?: boolean` confirmed in installed types), Tailwind v4 + custom utilities in `frontend/src/index.css`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-25-shell-intro-and-page-crossfade-design.md`

## Global Constraints

- Frontend commands run from `frontend/`; suites from repo root (`./test_frontend.sh`).
- Intro policy (verbatim from spec): plays **always after login** and **on any real page load**; **never** on internal navigation including round-trips out of the Layout route tree.
- Exactly one of {view-transition crossfade, `animate-page-in` rise} may apply per browser — never both.
- Crossfade values: 250ms, `var(--ease-signature)`; disabled under `prefers-reduced-motion: reduce`.
- All custom CSS goes in `frontend/src/index.css` (Tailwind v4, no config file).
- Do not change any other entrance utility's values.

---

### Task 1: Shell intro gating

**Files:**
- Modify: `frontend/src/components/Layout.tsx` (module scope + 5 gate sites: header ~line 501, aside ~529, two footer rows ~671/~767, banner delay ~893)
- Modify: `frontend/src/pages/LoginPage.tsx` (arm on mount)
- Test: `frontend/src/__tests__/components/ShellIntro.test.tsx` (new)

**Interfaces:**
- Produces: `export function armShellIntro(): void` from `frontend/src/components/Layout.tsx` (module flag reset; also the test seam). Task 2 does not depend on it.

- [ ] **Step 1: Write the failing tests** — `frontend/src/__tests__/components/ShellIntro.test.tsx`. Copy the render/msw scaffolding (server handlers for `/api/v1/printers/`, auth status, etc.) from the top of `frontend/src/__tests__/components/Layout.test.tsx` — reuse its helpers/mocks module-for-module so Layout can mount. Core assertions:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
// ...same render + msw setup imports as Layout.test.tsx...
import { Layout, armShellIntro } from '../../components/Layout';

// Renders Layout inside the same router/query wrappers Layout.test.tsx uses.
declare function renderLayout(): { unmount: () => void; container: HTMLElement };

describe('shell intro gating', () => {
  beforeEach(() => {
    armShellIntro(); // reset module state between tests
  });

  it('plays the intro on the first Layout mount of a session', async () => {
    const { container } = renderLayout();
    await waitFor(() => {
      expect(container.querySelector('.animate-sidebar-in, .animate-topbar-in')).not.toBeNull();
    });
  });

  it('does not replay the intro on a second mount in the same session', async () => {
    const first = renderLayout();
    await waitFor(() => expect(first.container.querySelector('aside, header')).not.toBeNull());
    first.unmount();

    const second = renderLayout();
    await waitFor(() => expect(second.container.querySelector('aside, header')).not.toBeNull());
    expect(second.container.querySelector('.animate-sidebar-in')).toBeNull();
    expect(second.container.querySelector('.animate-topbar-in')).toBeNull();
    expect(second.container.querySelector('.stagger-fade-in')).toBeNull();
  });

  it('replays the intro after armShellIntro() (login path)', async () => {
    const first = renderLayout();
    await waitFor(() => expect(first.container.querySelector('aside, header')).not.toBeNull());
    first.unmount();

    armShellIntro();
    const second = renderLayout();
    await waitFor(() => {
      expect(second.container.querySelector('.animate-sidebar-in, .animate-topbar-in')).not.toBeNull();
    });
  });
});
```

Note: which of `.animate-sidebar-in` (desktop aside) vs `.animate-topbar-in` (compact header) renders depends on the `useIsSidebarCompact()` result under jsdom — assert on the union selector as shown, and in the no-replay test assert BOTH are absent.

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/ShellIntro.test.tsx`
Expected: FAIL — `armShellIntro` is not exported.

- [ ] **Step 3: Implement the gate in Layout.tsx.** At module scope (below the imports, near `defaultNavItems`):

```tsx
// The shell intro (sidebar/topbar slide-in, footer icon stagger, banner delay)
// should play only when arriving in the app — after login, or on a real page
// load. Module state survives React remounts within a JS session (returning
// from /camera/:id, SpoolBuddy, etc. must NOT replay it) and resets naturally
// on any full reload. LoginPage re-arms it so every login gets the intro.
let shellIntroPlayed = false;
export function armShellIntro() {
  shellIntroPlayed = false;
}
```

Inside `Layout()`, next to the other `useState` calls:

```tsx
// Latch once per mount: first Layout mount of the session plays the intro.
const [playIntro] = useState(() => {
  const play = !shellIntroPlayed;
  shellIntroPlayed = true;
  return play;
});
```

Gate the five sites (exact current → new):
1. Header ~501: `className="animate-topbar-in fixed top-0 ..."` → `` className={`${playIntro ? 'animate-topbar-in' : ''} fixed top-0 ...`} ``
2. Aside ~529 (inside the existing template literal): `z-30 animate-sidebar-in ${...}` → `` z-30 ${playIntro ? 'animate-sidebar-in' : ''} ${...} ``
3. Footer row ~671: `flex-wrap stagger-fade-in` → `` flex-wrap ${playIntro ? 'stagger-fade-in' : ''} ``
4. Footer row ~767: `max-h-[50vh] stagger-fade-in` → `` max-h-[50vh] ${playIntro ? 'stagger-fade-in' : ''} ``
5. Banner ~893: `style={{ animationDelay: 'var(--sidebar-in-duration)' }}` → `style={{ animationDelay: playIntro ? 'var(--sidebar-in-duration)' : '0ms' }}` and extend the comment: the banner keeps `animate-banner-in` either way, only the wait is skipped.

- [ ] **Step 4: Arm from LoginPage.** In `frontend/src/pages/LoginPage.tsx` (component `LoginPage` at ~line 111): add `import { armShellIntro } from '../components/Layout';` and inside the component a mount effect:

```tsx
// Arriving at the login screen means the next Layout mount is a genuine
// app entry — re-arm the shell intro so login → dashboard always animates.
useEffect(() => {
  armShellIntro();
}, []);
```

(Importing Layout from LoginPage is safe — LoginPage already lives in the same bundle graph; if a circular-import warning appears at build, move `shellIntroPlayed`/`armShellIntro` to a new tiny module `frontend/src/components/shellIntro.ts` exporting `{ armShellIntro, consumeShellIntro }` where `consumeShellIntro()` returns the latch value, and import it from both files.)

- [ ] **Step 5: Run tests to verify pass**

Run: `cd frontend && npx vitest run src/__tests__/components/ShellIntro.test.tsx src/__tests__/components/Layout.test.tsx`
Expected: all PASS (Layout.test.tsx must not regress; its renders now count as "first mount" per test file — if any of its tests assert entrance classes are absent/present, adjust ONLY by calling `armShellIntro()` in a beforeEach, not by changing its assertions).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Layout.tsx frontend/src/pages/LoginPage.tsx frontend/src/__tests__/components/ShellIntro.test.tsx
git commit -m "feat(motion): shell intro plays after login and real loads only"
```

---

### Task 2: View Transitions crossfade

**Files:**
- Modify: `frontend/src/components/Layout.tsx` (4 NavLink sites ~lines 579/618/689/794; keyboard nav `navigate` call ~465-475; aside `view-transition-name`)
- Modify: `frontend/src/components/AnimatedOutlet.tsx`
- Modify: `frontend/src/index.css`
- Test: `frontend/src/__tests__/components/AnimatedOutlet.test.tsx` (new)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing tests** — `frontend/src/__tests__/components/AnimatedOutlet.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AnimatedOutlet } from '../../components/AnimatedOutlet';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AnimatedOutlet />}>
          <Route path="/" element={<div>home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  // @ts-expect-error test cleanup of the stub
  delete document.startViewTransition;
});

describe('AnimatedOutlet entrance vs view transitions', () => {
  it('uses animate-page-in when the browser has no View Transitions', () => {
    const { container } = renderAt('/');
    expect(container.querySelector('.animate-page-in')).not.toBeNull();
  });

  it('drops animate-page-in when document.startViewTransition exists', () => {
    // @ts-expect-error jsdom has no VT; stub it
    document.startViewTransition = () => ({});
    const { container } = renderAt('/');
    expect(container.querySelector('.animate-page-in')).toBeNull();
    expect(container.textContent).toContain('home');
  });
});
```

CAUTION: AnimatedOutlet must read `document.startViewTransition` per render or via a lazily-initialized check the test can influence — NOT a module-scope constant evaluated at import time (the stub in test 2 is installed after import). Use `useState(() => typeof document.startViewTransition === 'function')` inside the component (state initializer runs at mount, after the stub exists).

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run src/__tests__/components/AnimatedOutlet.test.tsx`
Expected: test 2 FAILS (`animate-page-in` still present with the stub installed).

- [ ] **Step 3: Update AnimatedOutlet.tsx** (current file is 23 lines; full replacement):

```tsx
import { useState } from 'react';
import { useLocation, useOutlet } from 'react-router-dom';

/**
 * Renders the routed page, mounting the destination immediately on navigation.
 *
 * Browsers with the View Transitions API get their page change animated by the
 * router-level crossfade (NavLinks/navigate pass `viewTransition`; see
 * index.css ::view-transition rules) — so this wrapper adds NO entrance class
 * there, otherwise the page would animate twice. Browsers without the API fall
 * back to the 250ms .animate-page-in rise. Exactly one of the two ever applies.
 *
 * Reduced-motion: .animate-page-in is neutralized in index.css's reduce block,
 * and the ::view-transition rules are disabled under the same media query.
 */
export function AnimatedOutlet() {
  const outlet = useOutlet();
  const location = useLocation();
  // Evaluated at mount (not import) so tests can stub startViewTransition.
  const [supportsViewTransitions] = useState(
    () => typeof document.startViewTransition === 'function',
  );

  return (
    <div key={location.pathname} className={supportsViewTransitions ? undefined : 'animate-page-in'}>
      {outlet}
    </div>
  );
}
```

- [ ] **Step 4: Opt the navigations in (Layout.tsx).**
  - All four `<NavLink` sites (~579 external-link entry, ~618 main nav items, ~689 and ~794 in the compact/mobile variants — relocate by grepping `<NavLink`): add the prop `viewTransition`. Do NOT add it to plain `<a>` external links.
  - Keyboard shortcut block (~465-475, inside the `keyNum` branch): change the internal-navigation call `navigate(navItem.to)` to `navigate(navItem.to, { viewTransition: true })`. Leave the external-link branch untouched.
  - Aside (~529): add Tailwind arbitrary property `[view-transition-name:sidebar]` to the aside's className (base part, both compact and desktop branches share the tag) so the sidebar stays pixel-static during crossfades.

- [ ] **Step 5: Add the crossfade CSS** to `frontend/src/index.css`, next to the `.animate-page-in` block:

```css
/* Router-driven View Transitions crossfade (NavLinks pass `viewTransition`).
   The old page's snapshot fades into the new one — no bare-background flash.
   Browsers without the API never create these pseudo-elements and use
   .animate-page-in instead (see AnimatedOutlet). The aside opts out via
   view-transition-name: sidebar so the static shell never flickers. */
::view-transition-old(root),
::view-transition-new(root) {
  animation-duration: 250ms;
  animation-timing-function: var(--ease-signature);
}
::view-transition-old(sidebar),
::view-transition-new(sidebar) {
  animation: none;
}
@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(root),
  ::view-transition-new(root) {
    animation: none;
  }
}
```

- [ ] **Step 6: Run tests + build**

Run: `cd frontend && npx vitest run src/__tests__/components/AnimatedOutlet.test.tsx src/__tests__/components/Layout.test.tsx && npm run build`
Expected: all PASS, build exit 0.

- [ ] **Step 7: Full suite**

Run: `cd /Users/paultheis/Documents/Code/bambuddy && ./test_frontend.sh`
Expected: PASS (known-flaky PrintModal.test.tsx tolerated only if it passes standalone).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/AnimatedOutlet.tsx frontend/src/components/Layout.tsx frontend/src/index.css frontend/src/__tests__/components/AnimatedOutlet.test.tsx
git commit -m "feat(motion): view-transition crossfade between pages, static sidebar"
```

---

### Manual feel checks (after both tasks — requires a browser, not automatable)

- Login → dashboard: full intro (sidebar slides in, icons stagger, banner waits).
- F5: intro replays. Navigate to a camera page and back: NO intro.
- Sidebar navigation in Chrome/Safari: pages crossfade with no background flash; sidebar rock-solid. Firefox (if <139): instant mount + rise entrance, as before.
- Reduced motion (DevTools Rendering panel): navigation swaps instantly, no crossfade.
