import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { FollowupStrip } from '../../components/aito/FollowupStrip';
import type { FollowupBucket, FollowupKey } from '../../utils/aitoFollowups';

const bucket = (key: FollowupKey, ids: number[], maxDays: number): FollowupBucket => ({ key, ids, maxDays });
const buckets: Record<FollowupKey, FollowupBucket> = {
  quoteOut: bucket('quoteOut', [1, 2], 60),
  notTold: bucket('notTold', [], 0),
  notCollected: bucket('notCollected', [], 0),
  unpaid: bucket('unpaid', [], 0),
  linkExpiring: bucket('linkExpiring', [], 0),
};

/** The desktop header's pills compact by container width, in steps: the
 *  longest wait goes first, then the label and glyph, so the row never
 *  wraps on a laptop. Container-query variants — the strip does not know
 *  the window, only the header it sits in. */
describe('FollowupStrip responsive', () => {
  it('hides the wait below 1950px and the label below 1580px of header width', () => {
    render(<FollowupStrip responsive buckets={buckets} active={null} onChange={() => {}} />);
    const pill = screen.getByTestId('aito-followup-quoteOut');
    expect(pill).toHaveTextContent(/2.*Quotes out.*60 d/);
    expect(screen.getByText('60 d')).toHaveClass('@max-[1950px]:hidden');
    expect(screen.getByText('Quotes out')).toHaveClass('@max-[1580px]:hidden');
    expect(pill.querySelector('svg')).toHaveClass('@max-[1580px]:hidden');
  });

  it('names the bucket in the tooltip, since the label may be the part that is hidden', () => {
    render(<FollowupStrip responsive buckets={buckets} active={null} onChange={() => {}} />);
    const title = screen.getByTestId('aito-followup-quoteOut').getAttribute('title') ?? '';
    expect(title).toMatch(/Quotes out/);
    expect(title).toMatch(/60 d/);
  });

  it('adds no container variants without the prop', () => {
    render(<FollowupStrip buckets={buckets} active={null} onChange={() => {}} />);
    expect(screen.getByTestId('aito-followup-quoteOut').innerHTML).not.toContain('@max-');
  });
});
