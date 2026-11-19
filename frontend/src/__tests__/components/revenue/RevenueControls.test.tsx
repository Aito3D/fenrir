import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RevenueControls } from '../../../components/revenue/RevenueControls';
import type { RangeChoice } from '../../../components/revenue/lib/dashboard';
import type { CustomerSegment, RevenueGranularity, RevenueKind } from '../../../components/revenue/lib/types';

function renderControls(
  o: {
    granularity?: RevenueGranularity;
    range?: RangeChoice;
    canPrev?: boolean;
    canNext?: boolean;
    kind?: RevenueKind | null;
    segment?: CustomerSegment | null;
    showSegment?: boolean;
  } = {},
) {
  const spies = { onGranularity: vi.fn(), onRange: vi.fn(), onShift: vi.fn(), onKind: vi.fn(), onSegment: vi.fn() };
  const view = render(
    <>
      <RevenueControls
        granularity={o.granularity ?? 'month'}
        range={o.range ?? { preset: 'last-12-months' }}
        from="2025-12-01"
        to="2026-11-19"
        today="2026-11-19"
        canPrev={o.canPrev ?? true}
        canNext={o.canNext ?? true}
        kind={o.kind ?? null}
        segment={o.segment ?? null}
        showSegment={o.showSegment ?? true}
        {...spies}
      />
      <input aria-label="typing input" />
      <textarea aria-label="typing area" />
      <select aria-label="typing select">
        <option>x</option>
      </select>
      <div aria-label="typing editable" contentEditable suppressContentEditableWarning />
    </>,
  );
  return { ...spies, ...view };
}

describe('RevenueControls — period stepping', () => {
  it('disables ‹ and › at the edges and steps by one period', () => {
    const { onShift } = renderControls({ canPrev: false, canNext: true });
    expect(screen.getByRole('button', { name: 'Previous period (←)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next period (→)' }));
    expect(onShift).toHaveBeenCalledWith(1);
  });

  it('prints the window being shown', () => {
    renderControls();
    expect(screen.getByText(/Dec 1, 25.*Nov 19, 26/)).toBeInTheDocument();
  });
});

describe('RevenueControls — keyboard shortcuts', () => {
  it('J S M A pick the granularity and ← → step the period', () => {
    const { onGranularity, onShift } = renderControls();
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'S' });
    fireEvent.keyDown(window, { key: 'm' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(onGranularity.mock.calls.map((c) => c[0])).toEqual(['day', 'week', 'month', 'year']);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onShift.mock.calls.map((c) => c[0])).toEqual([-1, 1]);
  });

  it('ignores the shortcuts with Ctrl, Meta or Alt held', () => {
    const { onGranularity, onShift } = renderControls();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    expect(onGranularity).not.toHaveBeenCalled();
    expect(onShift).not.toHaveBeenCalled();
  });

  it('ignores the shortcuts while typing in an input, textarea, select or contenteditable', () => {
    const { onGranularity, onShift } = renderControls();
    for (const name of ['typing input', 'typing area', 'typing select', 'typing editable']) {
      const el = screen.getByLabelText(name);
      fireEvent.keyDown(el, { key: 'j' });
      fireEvent.keyDown(el, { key: 'ArrowLeft' });
    }
    expect(onGranularity).not.toHaveBeenCalled();
    expect(onShift).not.toHaveBeenCalled();
  });

  it('removes its listener on unmount', () => {
    const { onGranularity, unmount } = renderControls();
    unmount();
    fireEvent.keyDown(window, { key: 'j' });
    expect(onGranularity).not.toHaveBeenCalled();
  });

  it('the granularity control picks a granularity on click', () => {
    const { onGranularity } = renderControls();
    expect(screen.getByRole('button', { name: 'Month' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(onGranularity).toHaveBeenCalledWith('week');
  });
});

describe('RevenueControls — range popover', () => {
  it('lists the presets and Auto, picks one and closes', () => {
    const { onRange } = renderControls();
    fireEvent.click(screen.getByRole('button', { name: /Last 12 months/ }));
    const popover = screen.getByRole('dialog', { name: 'Date range' });
    expect(within(popover).getByRole('button', { name: 'Last 12 months' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Since 2024' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Auto/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'This year' }));
    expect(onRange).toHaveBeenCalledWith({ preset: 'this-year' });
    expect(screen.queryByRole('button', { name: 'Since 2024' })).toBeNull();
  });

  it('bounds the custom dates by 2024-01-01 and today', () => {
    const { onRange } = renderControls();
    fireEvent.click(screen.getByRole('button', { name: /Last 12 months/ }));
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    for (const input of [from, to]) {
      expect(input).toHaveAttribute('min', '2024-01-01');
      expect(input).toHaveAttribute('max', '2026-11-19');
    }
    expect(from).toHaveValue('2025-12-01');
    fireEvent.change(from, { target: { value: '2025-03-01' } });
    expect(onRange).toHaveBeenCalledWith({ preset: 'custom', from: '2025-03-01', to: '2026-11-19' });
  });

  it('labels the trigger Auto or Custom and closes on Escape', () => {
    renderControls({ range: { preset: 'custom', from: '2025-01-01', to: '2025-02-01' } });
    const trigger = screen.getByRole('button', { name: /Custom/ });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('RevenueControls — filters', () => {
  it('All / Goods / Services set the kind', () => {
    const { onKind } = renderControls({ kind: 'services' });
    expect(screen.getByRole('button', { name: 'Services' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Goods' }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onKind.mock.calls.map((c) => c[0])).toEqual(['goods', null]);
  });

  it('the segment selector picks a segment and names it on the trigger', () => {
    const { onSegment, rerender } = renderControls();
    fireEvent.click(screen.getByRole('button', { name: /All customers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Business' }));
    expect(onSegment).toHaveBeenCalledWith('pro');
    rerender(
      <RevenueControls
        granularity="month" range={{ preset: 'default' }} from="" to="" today="2026-11-19" canPrev canNext
        kind={null} segment="particulier" showSegment
        onGranularity={vi.fn()} onRange={vi.fn()} onShift={vi.fn()} onKind={vi.fn()} onSegment={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Individuals/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('hides the segment selector without revenue:view_customers', () => {
    renderControls({ showSegment: false });
    expect(screen.queryByRole('button', { name: /All customers/ })).toBeNull();
  });
});
