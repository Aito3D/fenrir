# Shell intro gating + page crossfade — design

Date: 2026-07-25
Status: approved by user (brainstorming session)

## Problem

1. The app-shell entrance animations (`animate-sidebar-in`, `animate-topbar-in`, footer `stagger-fade-in`, banner delay) replay whenever `Layout` remounts — not just on true app entry. Leaving the Layout route tree (standalone camera page `/camera/:id`, stream overlay, `/calculator/quote`, SpoolBuddy) and returning replays the whole intro, as does every full reload including the forced post-deploy chunk reload.
2. Page-to-page navigation reads as a brutal cut: the outgoing page unmounts instantly and the incoming one starts at `opacity: 0`, so one frame of bare background flashes between pages before the 250ms `animate-page-in` rise.

## User-approved policy

- Shell intro plays: **always after login** (it is the login→dashboard transition) and **on any real page load** (F5, deploy reload).
- Shell intro never plays on internal navigation, including round-trips out of the Layout route tree.
- Page changes crossfade smoothly (Option 1: native View Transitions), never flashing bare background.

## Part A — shell intro gating

- `frontend/src/components/Layout.tsx`, module scope:
  ```ts
  let shellIntroPlayed = false;
  export function armShellIntro() { shellIntroPlayed = false; }
  ```
  Module state survives React remounts within a JS session and resets on any real page load — exactly the approved policy's refresh semantics.
- In `Layout`, capture once per mount:
  ```ts
  const [playIntro] = useState(() => {
    const play = !shellIntroPlayed;
    shellIntroPlayed = true;
    return play;
  });
  ```
- `playIntro` gates every intro-only class/value:
  - `animate-topbar-in` on the compact header (`Layout.tsx:~501`)
  - `animate-sidebar-in` on the desktop aside (`Layout.tsx:~529`)
  - `stagger-fade-in` on both footer icon rows (`Layout.tsx:~671`, `~767`)
  - the dev-mode banner's `animationDelay`: `var(--sidebar-in-duration)` when `playIntro`, `0ms` otherwise (`Layout.tsx:~893`); the banner keeps `animate-banner-in` either way (it announces itself whenever it appears)
- `LoginPage` calls `armShellIntro()` on mount, so the mount of Layout that follows ANY login (first visit or mid-session re-auth) always plays the intro.
- Export a test-only reset (`armShellIntro` doubles as it) so Vitest module state can be controlled.

## Part B — View Transitions crossfade

- Sidebar `NavLink`s in Layout and the 1–9 keyboard-shortcut `navigate(...)` calls pass React Router v7's `viewTransition` option, wrapping those navigations in `document.startViewTransition` where supported.
- `frontend/src/index.css` additions:
  ```css
  ::view-transition-old(root),
  ::view-transition-new(root) {
    animation-duration: 250ms;
    animation-timing-function: var(--ease-signature);
  }
  @media (prefers-reduced-motion: reduce) {
    ::view-transition-old(root), ::view-transition-new(root) { animation: none; }
  }
  ```
- The desktop `<aside>` gets `[view-transition-name:sidebar]` so the unchanged sidebar stays pixel-static; only the content region crossfades. (The compact/mobile header may keep root participation — it's visually static too.)
- `AnimatedOutlet` feature-detects once (`typeof document.startViewTransition === 'function'`, module-scope constant):
  - VT-capable browsers: render WITHOUT `animate-page-in` — the crossfade is the transition. Non-opted-in navigations swap instantly (fast, acceptable).
  - Fallback browsers: current behavior unchanged (instant mount + 250ms `animate-page-in`).
- No double animation is possible: exactly one of {crossfade, rise-entrance} applies per browser.

## Error handling / edge cases

- Rapid navigation spam: the browser skips/interrupts in-flight view transitions natively; no queuing logic needed.
- `startViewTransition` throwing (detached documents, etc.) is not intercepted — React Router owns the call and falls back to a plain navigation.
- Reduced motion: crossfade disabled via the media query above; fallback browsers already have `animate-page-in` neutralized by the global reduce block.

## Testing

- Layout: renders intro classes on first mount per session; renders none on a second mount; renders them again after `armShellIntro()`.
- LoginPage: arms the intro on mount.
- AnimatedOutlet: with `document.startViewTransition` stubbed present → no `animate-page-in` class; absent → class present.
- Feel checks (browser): login → full intro; F5 → intro; open camera page and return → no intro; navigate between pages → no background flash, content crossfades; sidebar never flickers during crossfade.

## Out of scope

- View transitions on programmatic deep links and non-sidebar navigations.
- Shared-element morphs (per-card view-transition-names) — crossfade only.
