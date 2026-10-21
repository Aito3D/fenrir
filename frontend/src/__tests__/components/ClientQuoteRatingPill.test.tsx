import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { ClientQuoteRatingPill } from '../../components/aito/ClientRatingPill';
import type { AitoClientQuoteRating } from '../../api/client';

const base: AitoClientQuoteRating = {
  tier: 'bad',
  accepted_count: 2,
  declined_count: 15,
  expired_count: 3,
  pending_count: 0,
  score: 5 / 26,
  computed_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  stale: false,
};

describe('ClientQuoteRatingPill', () => {
  it('renders nothing while loading or when Books had nothing to say', () => {
    const { container, rerender } = render(<ClientQuoteRatingPill rating={undefined} />);
    expect(container.querySelector('[data-tier]')).toBeNull();
    rerender(<ClientQuoteRatingPill rating={{ ...base, tier: 'unavailable' }} />);
    expect(container.querySelector('[data-tier]')).toBeNull();
  });

  it.each([
    ['good', 'Good'],
    ['medium', 'Medium'],
    ['bad', 'Bad'],
    ['new', 'New'],
  ] as const)('shows the %s tier as a word', (tier, label) => {
    render(<ClientQuoteRatingPill rating={{ ...base, tier }} />);
    expect(screen.getByText(label).closest('[data-tier]')).toHaveAttribute('data-tier', tier);
  });

  it('is named as the QUOTE rating so it never reads as the payment one', () => {
    render(<ClientQuoteRatingPill rating={base} />);
    expect(screen.getByRole('img', { name: /quote rating: bad/i })).toBeInTheDocument();
  });

  it('counts declined and expired together as decided, and says how many went unanswered', () => {
    render(<ClientQuoteRatingPill rating={base} />);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Bad — 2 of 20 quotes accepted · 3 never answered');
    expect(tip).toHaveTextContent(/checked 12m ago/);
  });

  it('mentions quotes still waiting on the client', () => {
    render(<ClientQuoteRatingPill rating={{ ...base, expired_count: 0, declined_count: 1, pending_count: 2 }} />);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('2 of 3 quotes accepted · 2 awaiting an answer');
    expect(tip).not.toHaveTextContent(/never answered/);
  });

  it('explains a new client', () => {
    render(
      <ClientQuoteRatingPill
        rating={{ ...base, tier: 'new', accepted_count: 0, declined_count: 0, expired_count: 0, score: null }}
      />,
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('New — No quote answered yet');
  });

  it('flags a stale rating with its age', () => {
    render(<ClientQuoteRatingPill rating={{ ...base, stale: true }} />);
    expect(screen.getByText(/Bad · 12m ago/)).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Books unreachable — last known rating');
  });
});
