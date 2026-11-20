import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from '../../../components/mobile/Sheet';

const sheet = (onClose = vi.fn()) => {
  render(<Sheet label="Filters" onClose={onClose}>{() => <p>body</p>}</Sheet>);
  return screen.getByRole('dialog', { name: 'Filters' });
};

// jsdom's pointer events drop clientY, and timeStamp is never settable through init; React treats a 0 timeStamp as missing.
const ptr = (el: Element, type: string, clientY: number, timeStamp = 1) => {
  const e = new MouseEvent(type, { bubbles: true, clientY });
  Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  fireEvent(el, e);
};

describe('Sheet swipe', () => {
  it('follows the finger down and snaps back on a short slow drag', () => {
    const onClose = vi.fn();
    const el = sheet(onClose);
    ptr(el, 'pointerdown', 100, 1);
    ptr(el, 'pointermove', 130);
    expect(el.style.transform).toBe('translateY(30px)');
    ptr(el, 'pointerup', 130, 1000);
    expect(el.style.transform).toBe('');
    expect(el.className).not.toContain('animate-sheet-out');
  });

  it('closes on a fast flick below the distance threshold', async () => {
    const onClose = vi.fn();
    const el = sheet(onClose);
    ptr(el, 'pointerdown', 100, 1);
    ptr(el, 'pointerup', 140, 100);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
