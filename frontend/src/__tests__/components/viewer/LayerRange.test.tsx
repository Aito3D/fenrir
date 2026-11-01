/** The toolpath's vertical layer slider: two handles on one track, the keyboard nudges, a
 *  click on the track that moves the nearer end, a pointer drag, the play / speed buttons
 *  and the per-layer time ridge. */
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { LayerRange } from '../../../components/viewer/LayerRange';

function Harness({ count = 100, initial = [0, 99] as [number, number], weights = null as number[] | null, onSpeed = undefined as ((n: number) => void) | undefined, speed = 1 }) {
  const [range, setRange] = useState<[number, number]>(initial);
  const [playing, setPlaying] = useState(false);
  return (
    <LayerRange count={count} range={range} onChange={setRange} playing={playing} onTogglePlay={() => setPlaying((p) => !p)} weights={weights} speed={speed} onSpeed={onSpeed} />
  );
}

const top = () => screen.getByRole('slider', { name: 'Top layer' });
const bottom = () => screen.getByRole('slider', { name: 'Bottom layer' });

/** jsdom has no PointerEvent: a MouseEvent of the pointer type carries clientY, and pointerId is pinned on. */
function pointer(target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', init: { clientY?: number; pointerId?: number } = {}) {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: init.clientY ?? 0 });
  Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
  fireEvent(target, e);
}

/** The track is 200px tall from y=100 to y=300, so clientY=300 is layer 0 and clientY=100 the last. */
function sizeTrack() {
  const track = top().parentElement as HTMLElement;
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 300, height: 200, left: 0, right: 24, width: 24, x: 0, y: 100, toJSON: () => ({}) } as DOMRect);
  return track;
}

describe('LayerRange', () => {
  it('shows the count, 1-based handle values, and the band between the handles', () => {
    render(<Harness count={100} initial={[9, 49]} />);
    expect(screen.getByTestId('layer-range')).toHaveTextContent('100');
    expect(top()).toHaveAttribute('aria-valuenow', '50');
    expect(top()).toHaveAttribute('aria-valuemin', '1');
    expect(top()).toHaveAttribute('aria-valuemax', '100');
    expect(bottom()).toHaveAttribute('aria-valuenow', '10');
    expect(top()).toHaveAttribute('aria-orientation', 'vertical');
    // Layer 49 of 0..99 sits at 1 - 49/99 ≈ 50.5% from the top; layer 9 at ≈ 90.9%.
    expect(top().style.top).toBe(`${(1 - 49 / 99) * 100}%`);
    expect(bottom().style.top).toBe(`${(1 - 9 / 99) * 100}%`);
  });

  it('arrow keys nudge a handle by one layer, Page keys by ten, each clamped to the other handle and the ends', async () => {
    render(<Harness count={100} initial={[0, 99]} />);
    top().focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(top()).toHaveAttribute('aria-valuenow', '99');
    await userEvent.keyboard('{PageDown}');
    expect(top()).toHaveAttribute('aria-valuenow', '89');
    await userEvent.keyboard('{ArrowUp}{PageUp}{PageUp}');
    // 88 + 1 + 10 + 10 = 109, clamped to the last layer (index 99 → shown 100).
    expect(top()).toHaveAttribute('aria-valuenow', '100');
    bottom().focus();
    await userEvent.keyboard('{PageUp}{PageUp}');
    expect(bottom()).toHaveAttribute('aria-valuenow', '21');
    await userEvent.keyboard('{ArrowDown}');
    expect(bottom()).toHaveAttribute('aria-valuenow', '20');
    // The bottom never passes the top: pull the top down to 25, push the bottom up past it.
    top().focus();
    for (let i = 0; i < 8; i += 1) await userEvent.keyboard('{PageDown}');
    expect(top()).toHaveAttribute('aria-valuenow', '20');
    bottom().focus();
    await userEvent.keyboard('{PageUp}');
    expect(bottom()).toHaveAttribute('aria-valuenow', '20');
    // Other keys are left alone (no preventDefault, no change).
    await userEvent.keyboard('{ArrowLeft}');
    expect(bottom()).toHaveAttribute('aria-valuenow', '20');
  });

  it('a click on the track moves the nearer handle to that layer', () => {
    render(<Harness count={101} initial={[0, 100]} />);
    const track = sizeTrack();
    // y=140 is 80% up the track → layer 80: nearer the top (100) than the bottom (0).
    pointer(track, 'pointerdown', { clientY: 140 });
    expect(top()).toHaveAttribute('aria-valuenow', '81');
    // y=260 is 20% up → layer 20: nearer the bottom.
    pointer(track, 'pointerdown', { clientY: 260 });
    expect(bottom()).toHaveAttribute('aria-valuenow', '21');
    // A press on the band counts as the track; a press on a handle is that handle's own drag.
    pointer(track.querySelector('[data-band]')!, 'pointerdown', { clientY: 100 });
    expect(top()).toHaveAttribute('aria-valuenow', '101');
    (top() as HTMLButtonElement).setPointerCapture = vi.fn();
    pointer(top(), 'pointerdown', { clientY: 300 });
    expect(top()).toHaveAttribute('aria-valuenow', '101');
    expect(bottom()).toHaveAttribute('aria-valuenow', '21');
  });

  it('dragging a handle follows the pointer while captured, and only that handle moves', () => {
    render(<Harness count={101} initial={[0, 100]} />);
    sizeTrack();
    const setCapture = vi.fn();
    (top() as HTMLButtonElement).setPointerCapture = setCapture;
    // A move before any press does nothing.
    pointer(top(), 'pointermove', { clientY: 200 });
    expect(top()).toHaveAttribute('aria-valuenow', '101');
    pointer(top(), 'pointerdown', { clientY: 100, pointerId: 3 });
    expect(setCapture).toHaveBeenCalledWith(3);
    pointer(top(), 'pointermove', { clientY: 200 });
    expect(top()).toHaveAttribute('aria-valuenow', '51');
    // The bottom handle ignores a move that belongs to the top's drag.
    pointer(bottom(), 'pointermove', { clientY: 200 });
    expect(bottom()).toHaveAttribute('aria-valuenow', '1');
    pointer(top(), 'pointerup');
    pointer(top(), 'pointermove', { clientY: 300 });
    expect(top()).toHaveAttribute('aria-valuenow', '51');
  });

  it('the play button toggles, the speed button cycles 1× → 2× → 4× → 1×, and there is no speed button without onSpeed', async () => {
    const onSpeed = vi.fn();
    const first = render(<Harness onSpeed={onSpeed} speed={1} />);
    const play = screen.getByRole('button', { name: 'Play the layers' });
    expect(play).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(play);
    expect(play).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByTestId('layer-speed'));
    expect(onSpeed).toHaveBeenCalledWith(2);
    first.unmount();
    const second = render(<Harness onSpeed={onSpeed} speed={4} />);
    expect(screen.getByTestId('layer-speed')).toHaveTextContent('4×');
    await userEvent.click(screen.getByTestId('layer-speed'));
    expect(onSpeed).toHaveBeenLastCalledWith(1);
    second.unmount();
    render(<Harness />);
    expect(screen.queryByTestId('layer-speed')).not.toBeInTheDocument();
  });

  it('draws the time ridge from the per-layer weights (one bar per layer, the slowest full width) and hides it with fewer than two', () => {
    const { unmount } = render(<Harness count={4} initial={[0, 3]} weights={[1, 4, 2, 0]} />);
    const ridge = screen.getByTestId('layer-ridge');
    expect(ridge).toHaveAttribute('viewBox', '0 0 100 4');
    // Widths are shares of the slowest layer (4 s), with a 4% floor so an empty layer still shows.
    expect(ridge.querySelector('path')).toHaveAttribute('d', 'M0 4 L25.0 4 L25.0 3 L100.0 3 L100.0 2 L50.0 2 L50.0 1 L4.0 1 L4.0 0 L0 0 Z');
    unmount();
    render(<Harness count={4} initial={[0, 3]} weights={[5]} />);
    expect(screen.queryByTestId('layer-ridge')).not.toBeInTheDocument();
  });

  it('hides the bottom label when the two handles are too close to read, and a one-layer file sits at the top', () => {
    const { unmount } = render(<Harness count={100} initial={[40, 42]} />);
    const labels = screen.getByTestId('layer-range').querySelectorAll('span.pointer-events-none');
    expect(labels[0]).toHaveTextContent('43');
    expect(labels[1]).toHaveTextContent('41');
    expect((labels[1] as HTMLElement).style.visibility).toBe('hidden');
    unmount();
    render(<Harness count={1} initial={[0, 0]} />);
    expect(top().style.top).toBe('0%');
    expect(top()).toHaveAttribute('aria-valuenow', '1');
  });
});
