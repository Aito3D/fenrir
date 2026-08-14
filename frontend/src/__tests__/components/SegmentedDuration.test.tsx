import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SegmentedDuration } from '../../components/SegmentedDuration';
import type { DurationSegment } from '../../components/SegmentedDuration';

const SEGMENTS: DurationSegment[] = [
  { key: 'd', value: '0', unitLabel: 'd', ariaLabel: 'Days' },
  { key: 'h', value: '6', unitLabel: 'h', ariaLabel: 'Hours' },
  { key: 'm', value: '30', unitLabel: 'min', ariaLabel: 'Minutes' },
];

describe('SegmentedDuration', () => {
  it('gives every segment its own accessible name', () => {
    // The bug this replaces left hours and minutes as bare spinbuttons: only
    // the first input inherited a name, from the field label outside it.
    render(<SegmentedDuration segments={SEGMENTS} onSegmentChange={vi.fn()} />);
    expect(screen.getByRole('spinbutton', { name: 'Days' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue(6);
    expect(screen.getByRole('spinbutton', { name: 'Minutes' })).toHaveValue(30);
  });

  it('reports the segment key alongside the raw string, without parsing it', () => {
    // Parsing belongs to the adapters — one speaks free-typed strings, the
    // other speaks total minutes. The primitive must not pick a side.
    const onSegmentChange = vi.fn();
    render(
      <SegmentedDuration
        segments={[{ key: 'h', value: '', unitLabel: 'h', ariaLabel: 'Hours' }]}
        onSegmentChange={onSegmentChange}
      />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Hours' }), { target: { value: '7' } });
    expect(onSegmentChange).toHaveBeenCalledWith('h', '7');
  });

  it('fires onGroupBlur when focus leaves the whole group', async () => {
    const onGroupBlur = vi.fn();
    const user = userEvent.setup();
    render(
      <>
        <SegmentedDuration segments={SEGMENTS} onSegmentChange={vi.fn()} onGroupBlur={onGroupBlur} />
        <button type="button">outside</button>
      </>,
    );
    await user.click(screen.getByRole('spinbutton', { name: 'Minutes' }));
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(onGroupBlur).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onGroupBlur while tabbing between its own segments', async () => {
    // Normalizing mid-entry would rewrite the field under the operator's
    // fingers: typing 90 into minutes then tabbing to hours must not first
    // turn the 90 into 1h30.
    const onGroupBlur = vi.fn();
    const user = userEvent.setup();
    render(<SegmentedDuration segments={SEGMENTS} onSegmentChange={vi.fn()} onGroupBlur={onGroupBlur} />);
    await user.click(screen.getByRole('spinbutton', { name: 'Days' }));
    await user.tab();
    await user.tab();
    expect(screen.getByRole('spinbutton', { name: 'Minutes' })).toHaveFocus();
    expect(onGroupBlur).not.toHaveBeenCalled();
  });

  it('puts firstId on the first segment so an external label can target it', () => {
    render(<SegmentedDuration segments={SEGMENTS} onSegmentChange={vi.fn()} firstId="my-time" />);
    expect(screen.getByRole('spinbutton', { name: 'Days' })).toHaveAttribute('id', 'my-time');
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).not.toHaveAttribute('id');
  });

  it('names the group from groupLabelId and marks every segment invalid on error', () => {
    render(
      <>
        <span id="time-label">Print time</span>
        <SegmentedDuration segments={SEGMENTS} onSegmentChange={vi.fn()} groupLabelId="time-label" error />
      </>,
    );
    expect(screen.getByRole('group', { name: 'Print time' })).toBeInTheDocument();
    for (const name of ['Days', 'Hours', 'Minutes']) {
      expect(screen.getByRole('spinbutton', { name })).toHaveAttribute('aria-invalid', 'true');
    }
  });
});
