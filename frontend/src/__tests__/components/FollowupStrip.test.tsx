import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../utils';
import { FollowupStrip } from '../../components/aito/FollowupStrip';
import type { FollowupBucket, FollowupKey } from '../../utils/aitoFollowups';

const empty = (key: FollowupKey): FollowupBucket => ({ key, ids: [], maxDays: 0 });
const buckets = (over: Partial<Record<FollowupKey, FollowupBucket>> = {}) => ({
  quoteOut: empty('quoteOut'),
  notTold: empty('notTold'),
  notCollected: empty('notCollected'),
  unpaid: empty('unpaid'),
  ...over,
});

describe('FollowupStrip', () => {
  it('renders nothing when there is nothing to chase', () => {
    render(<FollowupStrip buckets={buckets()} active={null} onChange={vi.fn()} />);
    // Not `toBeEmptyDOMElement` on the container: the shared render wrapper
    // always mounts a toast viewport, so the container is never empty and the
    // assertion would pass for the wrong reason. The strip's own group role
    // is the thing that must be absent.
    expect(screen.queryByRole('group', { name: 'To chase' })).not.toBeInTheDocument();
  });

  it('shows one chip per non-empty bucket with its count and longest wait', () => {
    render(
      <FollowupStrip
        buckets={buckets({ quoteOut: { key: 'quoteOut', ids: [1, 2, 3], maxDays: 9 }, unpaid: { key: 'unpaid', ids: [4], maxDays: 0 } })}
        active={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('group', { name: 'To chase' })).toBeInTheDocument();
    const quote = screen.getByTestId('aito-followup-quoteOut');
    expect(quote).toHaveTextContent('Quotes out');
    expect(quote).toHaveTextContent('3');
    expect(quote).toHaveTextContent('9 d');
    expect(quote).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('aito-followup-unpaid')).not.toHaveTextContent(' d');
    expect(screen.queryByTestId('aito-followup-notTold')).not.toBeInTheDocument();
  });

  it('toggles: clicking a chip selects it, clicking the active one clears', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FollowupStrip buckets={buckets({ notTold: { key: 'notTold', ids: [1], maxDays: 2 } })} active={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('aito-followup-notTold'));
    expect(onChange).toHaveBeenLastCalledWith('notTold');
    rerender(
      <FollowupStrip buckets={buckets({ notTold: { key: 'notTold', ids: [1], maxDays: 2 } })} active="notTold" onChange={onChange} />,
    );
    expect(screen.getByTestId('aito-followup-notTold')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('aito-followup-notTold'));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('names the worst offender under each tile from the bucket\'s first id', () => {
    // `followups()` sorts ids longest wait first, so ids[0] is who to ring.
    render(
      <FollowupStrip
        buckets={buckets({ quoteOut: { key: 'quoteOut', ids: [7, 3], maxDays: 9 }, unpaid: { key: 'unpaid', ids: [4], maxDays: 3 } })}
        active={null}
        onChange={vi.fn()}
        projects={[
          { id: 3, client_name: 'Tehani', description: 'Bras de drone' },
          { id: 7, client_name: 'Dupont SARL', description: 'Support de caméra' },
          { id: 4, client_name: null, description: 'Boîtier' },
        ]}
      />,
    );
    expect(screen.getByTestId('aito-followup-quoteOut-worst')).toHaveTextContent('Dupont SARL · Support de caméra');
    expect(screen.getByTestId('aito-followup-quoteOut')).toHaveAccessibleName(/Quotes out 2 — Dupont SARL/);
    // No client: just the description, no dangling separator.
    expect(screen.getByTestId('aito-followup-unpaid-worst')).toHaveTextContent(/^Boîtier$/);
  });

  it('says the tiles are filters: a hint beside the heading and a title on each tile', () => {
    render(
      <FollowupStrip buckets={buckets({ notTold: { key: 'notTold', ids: [1], maxDays: 2 } })} active={null} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('group', { name: 'To chase' })).toHaveTextContent('Click a tile to show only those projects');
    expect(screen.getByTestId('aito-followup-notTold')).toHaveAttribute('title', 'Click a tile to show only those projects');
  });

  it('Escape clears an active filter', () => {
    const onChange = vi.fn();
    render(
      <FollowupStrip buckets={buckets({ notTold: { key: 'notTold', ids: [1], maxDays: 2 } })} active="notTold" onChange={onChange} />,
    );
    fireEvent.keyDown(screen.getByTestId('aito-followup-notTold'), { key: 'Escape' });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
