import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('FollowupStrip compact', () => {
  it('shows only the count, keeps the label for tooltips and screen readers, still filters', async () => {
    const onChange = vi.fn();
    render(<FollowupStrip compact buckets={buckets} active={null} onChange={onChange} />);
    const pill = screen.getByTestId('aito-followup-quoteOut');
    expect(pill).toHaveTextContent(/^2$/);
    expect(pill.getAttribute('aria-label')).toMatch(/2/);
    expect(pill.getAttribute('title')).toMatch(/60 d/);
    await userEvent.setup().click(pill);
    expect(onChange).toHaveBeenCalledWith('quoteOut');
  });

  it('keeps the full pill without compact', () => {
    render(<FollowupStrip buckets={buckets} active={null} onChange={() => {}} />);
    expect(screen.getByTestId('aito-followup-quoteOut').textContent).toMatch(/2.*60 d/);
  });
});
