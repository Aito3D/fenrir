import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import { render } from '../utils';
import { PresenceBanner } from '../../components/aito/PresenceBanner';

/** The fold wrapper is two levels above the banner's own testid: the grid,
 *  then the `min-h-0 overflow-hidden` track, then the bar. */
const foldOf = (banner: HTMLElement) => banner.parentElement!.parentElement!;

describe('PresenceBanner', () => {
  afterEach(() => vi.useRealTimers());

  it('renders nothing while nobody else is looking', () => {
    render(<PresenceBanner names={[]} />);
    expect(screen.queryByTestId('aito-presence-banner')).not.toBeInTheDocument();
  });

  it('unfolds from @starting-style on arrival, live and open', () => {
    render(<PresenceBanner names={['Marie']} />);
    const banner = screen.getByTestId('aito-presence-banner');
    expect(banner).toHaveTextContent('Marie');
    const fold = foldOf(banner);
    expect(fold.className).toContain('starting:grid-rows-[0fr]');
    expect(fold.className).toContain('grid-rows-[1fr]');
    expect(fold.className).toContain('motion-reduce:transition-opacity');
    expect(fold).not.toHaveAttribute('inert');
  });

  it('folds away over 200ms, still naming the viewer, before unmounting', () => {
    // The render where the viewer leaves must already be the closed-but-
    // mounted one — an unmount-then-remount would give the fold nothing to
    // run on — and the bar keeps its last name so it does not go blank on
    // the way out.
    vi.useFakeTimers();
    const { rerender } = render(<PresenceBanner names={['Marie']} />);
    rerender(<PresenceBanner names={[]} />);
    const banner = screen.getByTestId('aito-presence-banner');
    expect(banner).toHaveTextContent('Marie');
    const fold = foldOf(banner);
    expect(fold.className).toContain('grid-rows-[0fr]');
    expect(fold.className).toContain('opacity-0');
    expect(fold).toHaveAttribute('inert');
    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByTestId('aito-presence-banner')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('aito-presence-banner')).not.toBeInTheDocument();
  });

  it('reopens in place if the viewer comes back mid-fold', () => {
    vi.useFakeTimers();
    const { rerender } = render(<PresenceBanner names={['Marie']} />);
    rerender(<PresenceBanner names={[]} />);
    act(() => vi.advanceTimersByTime(100));
    rerender(<PresenceBanner names={['Marie', 'Paul']} />);
    const fold = foldOf(screen.getByTestId('aito-presence-banner'));
    expect(fold.className).toContain('grid-rows-[1fr]');
    expect(fold).not.toHaveAttribute('inert');
    expect(screen.getByTestId('aito-presence-banner')).toHaveTextContent('Marie, Paul');
    // The abandoned exit timer must not unmount a banner that reopened.
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId('aito-presence-banner')).toBeInTheDocument();
  });
});
