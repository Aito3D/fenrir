import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { ClientRatingPill } from '../../components/aito/ClientRatingPill';
import type { AitoClientRating } from '../../api/client';

const base: AitoClientRating = {
  tier: 'good', reason: 'punctual',
  settled_count: 12, on_time_count: 12, overdue_count: 0, past_due_count: 0,
  worst_overdue_days: 0, worst_overdue_number: null,
  computed_at: new Date(Date.now() - 12 * 60_000).toISOString(), stale: false,
};

describe('ClientRatingPill', () => {
  it('renders nothing while loading or when Books had nothing to say', () => {
    const { container, rerender } = render(<ClientRatingPill rating={undefined} />);
    expect(container.querySelector('[data-tier]')).toBeNull();
    rerender(<ClientRatingPill rating={{ ...base, tier: 'unavailable', reason: null }} />);
    expect(container.querySelector('[data-tier]')).toBeNull();
  });

  it.each([
    ['good', 'Good'],
    ['medium', 'Medium'],
    ['bad', 'Bad'],
    ['new', 'New'],
  ] as const)('shows the %s tier as a word', (tier, label) => {
    render(<ClientRatingPill rating={{ ...base, tier }} />);
    const pill = screen.getByText(label).closest('[data-tier]');
    expect(pill).toHaveAttribute('data-tier', tier);
  });

  it('hides the new tier when asked, and only that one', () => {
    const { container, rerender } = render(<ClientRatingPill rating={{ ...base, tier: 'new', reason: 'new' }} hideNew />);
    expect(container.querySelector('[data-tier]')).toBeNull();
    rerender(<ClientRatingPill rating={{ ...base, tier: 'medium', reason: 'mixed' }} hideNew />);
    expect(container.querySelector('[data-tier="medium"]')).not.toBeNull();
  });

  it('explains an overdue rating with the count, the worst delay and its number', () => {
    render(
      <ClientRatingPill
        rating={{ ...base, tier: 'bad', reason: 'overdue', overdue_count: 2, worst_overdue_days: 23, worst_overdue_number: 'FA-26-4321' }}
      />,
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('2 invoices overdue · worst 23 days, FA-26-4321');
    expect(screen.getByRole('tooltip')).toHaveTextContent(/checked 12m ago/);
  });

  it('explains punctual, chronic and mixed with the counts', () => {
    const { rerender } = render(<ClientRatingPill rating={base} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('12 of 12 invoices paid on time');
    rerender(<ClientRatingPill rating={{ ...base, tier: 'bad', reason: 'chronic', on_time_count: 2, settled_count: 5 }} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Usually pays late · 2 of 5 paid on time');
    rerender(<ClientRatingPill rating={{ ...base, tier: 'medium', reason: 'mixed', on_time_count: 4, settled_count: 5, past_due_count: 1 }} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('4 of 5 paid on time · 1 past due');
  });

  it('marks a stale rating and says why in the tooltip', () => {
    const { container } = render(<ClientRatingPill rating={{ ...base, stale: true }} />);
    const pill = container.querySelector('[data-tier]');
    expect(pill).toHaveAttribute('data-stale', 'true');
    expect(pill).toHaveTextContent(/Good · 12m ago/);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Books unreachable/);
  });

  it('announces the tier and the reason to assistive tech', () => {
    render(<ClientRatingPill rating={base} />);
    expect(screen.getByLabelText(/Client rating: Good\. 12 of 12 invoices paid on time/)).toBeInTheDocument();
  });

  it('omits the checked time when the rating was never computed', () => {
    render(<ClientRatingPill rating={{ ...base, tier: 'new', reason: 'new', computed_at: null }} />);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(/No settled invoice yet/);
    expect(tooltip).not.toHaveTextContent(/checked/);
  });

  it('exposes the tier word through the tooltip as well', () => {
    render(<ClientRatingPill rating={base} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Good — 12 of 12 invoices paid on time/);
  });
});
