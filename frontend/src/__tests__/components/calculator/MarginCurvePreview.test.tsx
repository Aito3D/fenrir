/**
 * T-006 regression: the size chart's domain (`sizeMax = margin_k * 10`) is
 * exactly the value the K drag handle writes back through `onDragK`. Before
 * the fix, every pointermove re-derived K from a domain that K itself had
 * just moved on the previous move, compounding roughly ×10 per event and
 * blowing K up by orders of magnitude over the course of one real drag —
 * see MarginCurvePreview.tsx and DragHandle.tsx. `usePlotArea` is mocked to
 * a fixed pixel rect (as in DragHandle.test.tsx) so the drag has
 * deterministic geometry without needing recharts' real measurement.
 */
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MarginCurvePreview } from '../../../components/calculator/MarginCurvePreview';
import { qtyDomainMax } from '../../../components/calculator/curveGeometry';
import type { PricingDefaults } from '../../../utils/pricing';

// `ResponsiveContainer` measures its DOM node in real recharts, which is
// always 0×0 in jsdom — with a 0-width plot recharts renders nothing inside
// the `<svg>` at all, so `DragHandle` never mounts. Overriding
// `ResponsiveContainer` to a fixed pixel width (as
// CalculatorSettingsPanelDrag.test.tsx does) lets the rest of recharts'
// real layout run, and `usePlotArea` is further pinned to a fixed rect so
// the drag has deterministic, hand-checkable geometry.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={600} />
    ),
    usePlotArea: () => ({ x: 50, y: 0, width: 200, height: 100 }),
  };
});

// jsdom has no global `PointerEvent` — see DragHandle.test.tsx's header note
// for why a minimal polyfill is required to drive a numeric pointer drag.
class PointerEventPolyfill extends MouseEvent {
  pointerId: number;
  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 0;
  }
}
if (typeof window.PointerEvent === 'undefined') {
  // @ts-expect-error jsdom does not ship a PointerEvent constructor
  window.PointerEvent = PointerEventPolyfill;
}

const baseDefaults: PricingDefaults = {
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 100,
  stuff_markup_pct: 20,
  base_fee_flat: 0,
  margin_min_mult: 1.15,
  margin_max_mult: 1.6,
  margin_k: 33, // the shipped default named in the finding
  qty_min_factor: 0.4,
  qty_k: 5,
  min_task_price: 12,
};

/** Wraps MarginCurvePreview with the bit of state a real caller (the
 *  settings form) supplies: `onDragK` writes back into `d.margin_k`. */
function DragHost({ onK }: { onK?: (k: number) => void }) {
  const [d, setD] = useState<PricingDefaults>(baseDefaults);
  return (
    <MarginCurvePreview
      d={d}
      currency="USD"
      example={{ unitCost: '', quantity: '' }}
      onExampleChange={() => {}}
      onDragK={(k) => {
        setD((prev) => ({ ...prev, margin_k: k }));
        onK?.(k);
      }}
      onDragKQ={() => {}}
    />
  );
}

function getKStrip() {
  const grip = screen.getByRole('slider', { name: 'Drag to set K' });
  return grip.parentElement!.querySelector('[data-testid="drag-strip"]')!;
}

describe('MarginCurvePreview — K drag handle domain', () => {
  it('does not compound K across repeated pointermoves held at a fixed plot position', () => {
    const onK = vi.fn();
    render(<DragHost onK={onK} />);
    const strip = getKStrip();

    // svg bounding rect is 0 in jsdom, so plot-left is 50, width 200. Holding
    // the pointer at clientX=110 is 30 % across the plot (matches the
    // finding's "held at 30 % of the plot" repro) for every move.
    fireEvent.pointerDown(strip, { clientX: 110, pointerId: 1 });
    for (let i = 0; i < 8; i++) {
      fireEvent.pointerMove(strip, { clientX: 110, pointerId: 1, buttons: 1 });
    }
    fireEvent.pointerUp(strip, { pointerId: 1 });

    // With the fix, the domain used to interpret clientX=110 is frozen at
    // the K the drag started with (33 → sizeMax 330), so every one of the
    // nine calls (1 down + 8 moves) maps the *same* pixel to the *same*
    // value and none of them compound: 30 % of 330 = 99, rounded by roundK.
    for (const call of onK.mock.calls) {
      expect(call[0]).toBe(99);
    }
    // Before the fix this last call would have been 216000 (99 × 10^≈3.3).
    expect(onK).toHaveBeenLastCalledWith(99);
  });

  it('unfreezes the domain after pointerUp so it reflects the live, post-drop K', () => {
    // Companion to the "does not compound" test above: that test only ever
    // reads `onK`'s call values, never re-checking the handle's own
    // `aria-valuemax` once the gesture completes. The frozen anchor
    // (`kDragAnchor`) is supposed to clear on `onDragEnd`, so the domain
    // should go back to scaling off the live (post-drop) K rather than
    // staying pinned to the K the drag started with.
    const onK = vi.fn();
    render(<DragHost onK={onK} />);
    const strip = getKStrip();

    fireEvent.pointerDown(strip, { clientX: 110, pointerId: 1 });
    for (let i = 0; i < 8; i++) {
      fireEvent.pointerMove(strip, { clientX: 110, pointerId: 1, buttons: 1 });
    }
    fireEvent.pointerUp(strip, { pointerId: 1 });

    // The drag above lands on K=99 (30 % of the frozen 330 domain — see the
    // "does not compound" test's math). `DragHost` feeds that back into `d`,
    // so once the anchor unfreezes the domain is 99 × 10 = 990, not the
    // drag-start anchor's 33 × 10 = 330.
    expect(onK).toHaveBeenLastCalledWith(99);
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    expect(grip).toHaveAttribute('aria-valuemax', '990');
  });

  it('still lets the domain track K normally outside of a drag (typed edits, or after drop)', () => {
    // Regression guard for the freeze itself: once the drag ends the anchor
    // clears and the chart must go back to scaling with the live K, exactly
    // as it did before this fix (typing a new K live-updates the axis).
    render(
      <MarginCurvePreview
        d={{ ...baseDefaults, margin_k: 100 }}
        currency="USD"
        example={{ unitCost: '', quantity: '' }}
        onExampleChange={() => {}}
        onDragK={() => {}}
        onDragKQ={() => {}}
      />
    );
    const grip = screen.getByRole('slider', { name: 'Drag to set K' });
    // No drag has happened, so the domain must be derived from the live K
    // (100 × 10 = 1000), not any stale/default anchor.
    expect(grip).toHaveAttribute('aria-valuemax', '1000');
  });
});

/** Wraps MarginCurvePreview with the bit of state a real caller (the
 *  settings form) supplies for the KQ handle: `onDragKQ` writes back into
 *  `d.qty_k`, exactly like `CalculatorSettingsPanel`'s
 *  `onDragKQ={(v) => setField('qty_k', String(v))}`. */
function KqDragHost({ startKq, onKq }: { startKq: number; onKq?: (kq: number) => void }) {
  const [d, setD] = useState<PricingDefaults>({ ...baseDefaults, qty_k: startKq });
  return (
    <MarginCurvePreview
      d={d}
      currency="USD"
      example={{ unitCost: '', quantity: '' }}
      onExampleChange={() => {}}
      onDragK={() => {}}
      onDragKQ={(kq) => {
        setD((prev) => ({ ...prev, qty_k: kq }));
        onKq?.(kq);
      }}
    />
  );
}

function getKqGrip() {
  return screen.getByRole('slider', { name: 'Drag to set KQ' });
}
function getKqStrip() {
  return getKqGrip().parentElement!.querySelector('[data-testid="drag-strip"]')!;
}

describe('MarginCurvePreview — KQ drag handle domain (T-049)', () => {
  it('a stored qty_k of 500 no longer clamps the handle to the domain edge, and an arrow key does not collapse it to 99', () => {
    render(<KqDragHost startKq={500} />);
    const grip = getKqGrip();

    // The domain now stretches past kq + 1 = 501 instead of staying pinned
    // at the un-stretched floor of 100.
    const expectedMax = qtyDomainMax(undefined, 500);
    expect(expectedMax).toBeGreaterThan(501);
    expect(grip).toHaveAttribute('aria-valuemax', String(expectedMax));
    // aria-valuenow announces the underlying field value (kq), not the
    // visual position (kq + 1) — unaffected by this fix.
    expect(grip).toHaveAttribute('aria-valuenow', '500');

    // Before the fix, ANY arrow key here clamped `value` (501) down to the
    // un-stretched `max` (100), and the KQ chart's `onChange` wrapper
    // (`Math.max(1, v - 1)`) turned that into `qty_k = 99` — see the
    // finding's exact repro. With the domain now containing 501 with room
    // to spare, a single ArrowLeft nudges the value down by a small,
    // pointer-implied amount instead of collapsing it.
    fireEvent.keyDown(grip, { key: 'ArrowLeft' });
    const newKq = Number(grip.getAttribute('aria-valuenow'));
    expect(newKq).not.toBe(99);
    expect(newKq).toBeGreaterThan(400); // nowhere near the old 100-floor clamp
  });

  it('small qty_k (today\'s shipped default and below) keeps the un-stretched 100-wide domain', () => {
    render(<KqDragHost startKq={5} />);
    const grip = getKqGrip();
    expect(grip).toHaveAttribute('aria-valuemax', '100');
  });

  it('does not exponentially compound kq across repeated pointermoves held at the plot\'s right edge (no drag anchor needed)', () => {
    // T-006 showed that a domain multiplicatively tied to the value it
    // renders (sizeMax = k * 10) compounds ~10x per held pointermove event
    // because the handle sits at a *constant* fraction (1/10) of its own
    // domain no matter how large the value gets. qtyDomainMax's kq
    // relationship is additive (kq + KQ_HEADROOM), so the same live-domain
    // read-back can add at most a constant per event — this test pins that
    // it is linear drift, not runaway exponential growth, holding the
    // pointer at the plot's clamped right edge (t = 1), the single worst
    // case for this formula.
    const onKq = vi.fn();
    render(<KqDragHost startKq={500} onKq={onKq} />);
    const strip = getKqStrip();

    // Plot rect is mocked to x=50, width=200 (see the `usePlotArea` mock
    // above) — clientX beyond `left + width` (250) clamps to the domain max.
    fireEvent.pointerDown(strip, { clientX: 999, pointerId: 1 });
    for (let i = 0; i < 8; i++) {
      fireEvent.pointerMove(strip, { clientX: 999, pointerId: 1, buttons: 1 });
    }
    fireEvent.pointerUp(strip, { pointerId: 1 });

    expect(onKq).toHaveBeenCalledTimes(9); // 1 down + 8 moves
    const values = onKq.mock.calls.map((c) => c[0] as number);
    // Each held-position event can add at most KQ_HEADROOM (a fixed
    // constant baked into qtyDomainMax, not exposed — 50 as of this fix) to
    // the previous value; never a multiplicative jump. Nine calls starting
    // from 500 stay in the low hundreds/thousands, orders of magnitude
    // below the K bug's 216000-from-33 blow-up over the same nine calls.
    for (let i = 1; i < values.length; i++) {
      expect(values[i] - values[i - 1]).toBeLessThanOrEqual(50);
    }
    expect(Math.max(...values)).toBeLessThan(1000);
  });
});
