import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { useSnapPager } from '../../hooks/useSnapPager';

const WIDTH = 390;
let widthSpy: PropertyDescriptor | undefined;
const scrollLeftStub: PropertyDescriptor & ThisType<HTMLElement & { __sl?: number }> = {
  configurable: true,
  get() { return this.__sl ?? 0; },
  set(value: number) { this.__sl = value; },
};

function Harness({ start = 0 }: { start?: number }) {
  const [current, setCurrent] = useState(start);
  const { pagerRef, jump, handlers } = useSnapPager(5, current, setCurrent);
  return (
    <div>
      <output data-testid="current">{current}</output>
      <button onClick={() => jump(4, true)}>jump4</button>
      <div ref={pagerRef} data-testid="pager" {...handlers}>
        {[0, 1, 2, 3, 4].map((i) => <section key={i} />)}
      </div>
    </div>
  );
}

beforeEach(() => {
  widthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => WIDTH });
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', scrollLeftStub);
});
afterEach(() => {
  vi.useRealTimers();
  if (widthSpy) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthSpy);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollLeft;
});

describe('useSnapPager', () => {
  it('lands on the starting page before paint and follows a swipe', () => {
    render(<Harness start={2} />);
    const pager = screen.getByTestId('pager');
    expect(pager.scrollLeft).toBe(WIDTH * 2);
    pager.scrollLeft = WIDTH * 3;
    fireEvent.scroll(pager);
    expect(screen.getByTestId('current')).toHaveTextContent('3');
  });

  it('settles on the nearest page once the finger is up, never under it', () => {
    vi.useFakeTimers();
    render(<Harness />);
    const pager = screen.getByTestId('pager');
    fireEvent.touchStart(pager);
    pager.scrollLeft = WIDTH * 2 + 250; // 2.64 pages
    fireEvent.scroll(pager);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(pager.scrollLeft).toBe(WIDTH * 2 + 250);
    fireEvent.touchEnd(pager);
    act(() => { vi.advanceTimersByTime(400); });
    expect(pager.scrollLeft).toBe(WIDTH * 3);
    expect(screen.getByTestId('current')).toHaveTextContent('3');
  });

  it('a smooth jump adopts the target at once and ignores the pages on the way', () => {
    render(<Harness />);
    const pager = screen.getByTestId('pager');
    fireEvent.click(screen.getByText('jump4'));
    expect(screen.getByTestId('current')).toHaveTextContent('4');
    expect(pager.style.scrollSnapType).toBe('none');
    pager.scrollLeft = WIDTH * 2;
    fireEvent.scroll(pager);
    expect(screen.getByTestId('current')).toHaveTextContent('4');
    pager.scrollLeft = WIDTH * 4;
    fireEvent.scroll(pager);
    expect(pager.style.scrollSnapType).toBe('');
  });

  it('re-aligns on a width change only', () => {
    render(<Harness start={1} />);
    const pager = screen.getByTestId('pager');
    pager.scrollLeft = WIDTH * 1 + 40;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pager.scrollLeft).toBe(WIDTH * 1 + 40); // same width: untouched
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pager.scrollLeft).toBe(800);
  });
});
