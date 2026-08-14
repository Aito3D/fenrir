import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { DurationInput } from '../../components/aito/DurationInput';

/** Feeds onChange back into state so multi-keystroke typing on a controlled
 *  input accumulates instead of every keystroke restarting from the same
 *  stale prop — the same wrapper AitoTaskStepFields.test.tsx uses. */
function Controlled({ initial, spy }: { initial: number | null; spy: (m: number | null) => void }) {
  const [minutes, setMinutes] = useState<number | null>(initial);
  return (
    <>
      <DurationInput
        minutes={minutes}
        onChange={(next) => {
          spy(next);
          setMinutes(next);
        }}
      />
      <button type="button">outside</button>
    </>
  );
}

describe('aito DurationInput', () => {
  it('splits stored minutes across the three segments', () => {
    render(<DurationInput minutes={1830} onChange={vi.fn()} />);
    expect(screen.getByRole('spinbutton', { name: 'Days' })).toHaveValue(1);
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue(6);
    expect(screen.getByRole('spinbutton', { name: 'Minutes' })).toHaveValue(30);
  });

  it('shows every segment empty, not zero, when the time is unset', () => {
    // An unset time disables the service upstream. Rendering 0/0/0 would
    // claim the operator entered a zero-minute print.
    render(<DurationInput minutes={null} onChange={vi.fn()} />);
    for (const name of ['Days', 'Hours', 'Minutes']) {
      expect(screen.getByRole('spinbutton', { name })).toHaveValue(null);
    }
  });

  it('normalizes overflow once focus leaves the group', async () => {
    // 90 minutes is a perfectly reasonable thing to type; it should settle to
    // 1 h 30 rather than sitting there as an out-of-range segment.
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Controlled initial={0} spy={spy} />);
    const min = screen.getByRole('spinbutton', { name: 'Minutes' });
    await user.clear(min);
    await user.type(min, '90');
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue(1);
    expect(screen.getByRole('spinbutton', { name: 'Minutes' })).toHaveValue(30);
    // Normalization is a display-only fallback to splitMinutes of the
    // already-emitted total — it must not fire a second onChange.
    expect(spy).toHaveBeenLastCalledWith(90);
  });

  it('does not normalize while tabbing between its own segments', async () => {
    const user = userEvent.setup();
    render(<Controlled initial={0} spy={vi.fn()} />);
    const min = screen.getByRole('spinbutton', { name: 'Minutes' });
    await user.clear(min);
    await user.type(min, '90');
    await user.tab({ shift: true });
    // The sibling segments must stay self-consistent with what is still
    // being drafted: hours must NOT tick up to 1 just because the stored
    // total (90) would split that way — the group is still mid-edit.
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Minutes' })).toHaveValue(90);
  });

  it('keeps sibling segments consistent while a single segment is mid-keystroke', async () => {
    // Typing "9" then "0" into minutes passes through a stored total of 9,
    // then 90. Neither intermediate render may let hours jump to 1 just
    // because splitMinutes(90) would put it there — minutes is still being
    // typed, not yet blurred.
    const user = userEvent.setup();
    render(<Controlled initial={0} spy={vi.fn()} />);
    const min = screen.getByRole('spinbutton', { name: 'Minutes' });
    await user.clear(min);
    await user.type(min, '9');
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Minutes' })).toHaveValue(9);
    await user.type(min, '0');
    expect(screen.getByRole('spinbutton', { name: 'Hours' })).toHaveValue(0);
    expect(screen.getByRole('spinbutton', { name: 'Minutes' })).toHaveValue(90);
  });

  it('emits nothing on blur when the split is already normal', async () => {
    // A no-op onChange here would mark the task dirty and, upstream, retrigger
    // pricing on every stray click.
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Controlled initial={90} spy={spy} />);
    await user.click(screen.getByRole('spinbutton', { name: 'Hours' }));
    await user.click(screen.getByRole('button', { name: 'outside' }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports null, not 0, when the last value is cleared', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Controlled initial={30} spy={spy} />);
    await user.clear(screen.getByRole('spinbutton', { name: 'Minutes' }));
    expect(spy).toHaveBeenLastCalledWith(null);
  });
});
