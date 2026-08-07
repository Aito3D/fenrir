/**
 * `HoldButton`'s disabled-mid-hold contract, tested directly against the
 * component rather than through a caller.
 *
 * Every real caller (FlagControl, DoneGrid, ProjectDoneAction, the board
 * card actions in BoardColumn) drives `disabled` off its own mutation's
 * `isPending`, and only ever renders one hold button per gesture — so there
 * is no way to force a sibling mutation to flip `disabled` mid-hold through
 * the full component tree. Unit-testing `HoldButton` in isolation, with a
 * controlled `disabled` prop, is the only way to exercise this path.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, act, render as rtlRender } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { HoldButton } from '../../components/aito/HoldButton';

function Subject(props: Partial<ComponentProps<typeof HoldButton>> & { onHold: () => void }) {
  return (
    <HoldButton durationMs={500} label="Test" hint="Hold 0.5s" disabled={false} {...props}>
      Go
    </HoldButton>
  );
}

describe('HoldButton disabled mid-hold', () => {
  // Characterization test: pins down the existing hold-commit path (a press
  // held past durationMs fires onHold exactly once) so the regression test
  // below proves the disabled-flip case diverges from it, rather than the
  // whole hold mechanism having broken.
  it('fires onHold once when held past durationMs and disabled never changes', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    rtlRender(<Subject onHold={onHold} />);
    const button = screen.getByRole('button', { name: 'Test' });
    fireEvent.pointerDown(button);
    act(() => vi.advanceTimersByTime(500));
    expect(onHold).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('cancels an in-flight hold and does not fire onHold when disabled flips true mid-hold', () => {
    vi.useFakeTimers();
    const onHold = vi.fn();
    const { rerender } = rtlRender(<Subject onHold={onHold} />);
    const button = screen.getByRole('button', { name: 'Test' });
    fireEvent.pointerDown(button);
    const wrapper = button.parentElement!;
    expect(wrapper.className).toContain('scale-[1.08]'); // holding visual state is on

    // Withdraw the action out from under the in-flight hold, before the
    // press would have completed.
    act(() => vi.advanceTimersByTime(200));
    rerender(<Subject onHold={onHold} disabled />);

    // Let the original hold duration fully elapse; if the timer survived
    // the disabled flip, onHold would fire here.
    act(() => vi.advanceTimersByTime(500));
    expect(onHold).not.toHaveBeenCalled();
    expect(wrapper.className).not.toContain('scale-[1.08]'); // holding visual state reset
    vi.useRealTimers();
  });
});
