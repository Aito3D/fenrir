import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, act, render as rtlRender } from '@testing-library/react';
import { render } from '../utils';
import { HoldButton } from '../../components/aito/HoldButton';

// The perimeter SVG only renders once the button has a measured box; jsdom
// reports 0 for offsetWidth/offsetHeight by default, which leaves `box` at
// its measured-but-zero state and the SVG absent from the DOM.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 40 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 24 });

function renderPerimeter(onHold = vi.fn()) {
  rtlRender(
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

describe('HoldButton pressEffect', () => {
  const base = {
    onHold: vi.fn(),
    durationMs: 500 as const,
    label: 'Test',
    hint: 'Hold 0.5s',
  };

  it('scales its wrapper while held by default', () => {
    render(<HoldButton {...base}>Go</HoldButton>);
    const wrapper = screen.getByRole('button').parentElement!;
    fireEvent.pointerDown(screen.getByRole('button'));
    expect(wrapper.className).toContain('scale-[1.08]');
  });

  it('does not scale its wrapper when pressEffect is none', () => {
    render(<HoldButton {...base} pressEffect="none">Go</HoldButton>);
    const wrapper = screen.getByRole('button').parentElement!;
    fireEvent.pointerDown(screen.getByRole('button'));
    expect(wrapper.className).not.toContain('scale-');
  });

  it('does not bounce on completion when pressEffect is none', () => {
    vi.useFakeTimers();
    render(<HoldButton {...base} pressEffect="none">Go</HoldButton>);
    const wrapper = screen.getByRole('button').parentElement!;
    fireEvent.pointerDown(screen.getByRole('button'));
    act(() => vi.advanceTimersByTime(500));
    expect(wrapper.className).not.toContain('animate-hold-bounce');
    vi.useRealTimers();
  });
});

describe('HoldButton pointer/keyboard cancellation', () => {
  const base = {
    onHold: vi.fn(),
    durationMs: 500 as const,
    label: 'Test',
    hint: 'Hold 0.5s',
  };

  it('cancels the hold on pointerleave before duration elapses, without firing onHold', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    render(<HoldButton {...base} onHold={onHold}>Go</HoldButton>);
    const button = screen.getByRole('button');
    const wrapper = button.parentElement!;
    fireEvent.pointerDown(button);
    expect(wrapper.className).toContain('scale-[1.08]');
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerLeave(button);
    expect(wrapper.className).not.toContain('scale-[1.08]');
    act(() => vi.advanceTimersByTime(500));
    expect(onHold).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels the hold on pointercancel before duration elapses, without firing onHold', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    render(<HoldButton {...base} onHold={onHold}>Go</HoldButton>);
    const button = screen.getByRole('button');
    const wrapper = button.parentElement!;
    fireEvent.pointerDown(button);
    expect(wrapper.className).toContain('scale-[1.08]');
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerCancel(button);
    expect(wrapper.className).not.toContain('scale-[1.08]');
    act(() => vi.advanceTimersByTime(500));
    expect(onHold).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cancels a keyboard hold on keyup before duration elapses, the same way a short pointer tap cancels', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    render(<HoldButton {...base} onHold={onHold}>Go</HoldButton>);
    const button = screen.getByRole('button');
    const wrapper = button.parentElement!;
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(wrapper.className).toContain('scale-[1.08]');
    act(() => vi.advanceTimersByTime(200));
    fireEvent.keyUp(button, { key: 'Enter' });
    expect(wrapper.className).not.toContain('scale-[1.08]');
    act(() => vi.advanceTimersByTime(500));
    expect(onHold).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
