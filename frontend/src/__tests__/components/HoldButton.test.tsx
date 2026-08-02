import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { HoldButton } from '../../components/aito/HoldButton';

// The perimeter SVG only renders once the button has a measured box; jsdom
// reports 0 for offsetWidth/offsetHeight by default, which leaves `box` at
// its measured-but-zero state and the SVG absent from the DOM.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 40 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 24 });

function renderPerimeter(onHold = vi.fn()) {
  render(
    <HoldButton onHold={onHold} durationMs={500} label="reset" hint="hold" progress="perimeter">
      x
    </HoldButton>,
  );
  return onHold;
}

describe('HoldButton completion choreography', () => {
  it('inflates the wrapper while holding', () => {
    vi.useFakeTimers();
    renderPerimeter();
    const button = screen.getByRole('button', { name: 'reset' });
    fireEvent.pointerDown(button);
    expect(button.parentElement!.className).toContain('scale-[1.08]');
    // The scale VALUE itself must be gated for reduced-motion users, not just
    // its transition — an untransitioned snap-inflate is still an inflate.
    expect(button.parentElement!.className).toContain('motion-reduce:scale-100');
    fireEvent.pointerUp(button);
    expect(button.parentElement!.className).not.toContain('scale-[1.08]');
    vi.useRealTimers();
  });

  it('on completion keeps progress full, fades it, bounces, and fires onHold', () => {
    vi.useFakeTimers();
    const onHold = renderPerimeter();
    const button = screen.getByRole('button', { name: 'reset' });
    fireEvent.pointerDown(button);
    act(() => vi.advanceTimersByTime(500));
    expect(onHold).toHaveBeenCalledOnce();
    const path = screen.getByTestId('hold-progress-perimeter').querySelector('path')!;
    expect(path.getAttribute('stroke-dashoffset')).toBe('0'); // stays full, no rewind
    expect(path.className.baseVal).toContain('transition-[stroke-opacity]');
    expect(button.parentElement!.className).toContain('animate-hold-bounce');
    act(() => vi.advanceTimersByTime(700)); // choreography window ends
    expect(button.parentElement!.className).not.toContain('animate-hold-bounce');
    vi.useRealTimers();
  });
});
