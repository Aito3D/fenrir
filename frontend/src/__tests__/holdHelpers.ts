import { act, fireEvent } from '@testing-library/react';

/** Presses a HoldButton for its full 1s on real timers, then releases. */
export async function holdToConfirm(button: HTMLElement, ms = 1100) {
  fireEvent.pointerDown(button);
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)));
  fireEvent.pointerUp(button);
}
