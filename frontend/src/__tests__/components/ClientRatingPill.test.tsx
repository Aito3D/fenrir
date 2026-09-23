import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { ClientRatingPill, ClientRatingRing } from '../../components/aito/ClientRatingPill';
import type { AitoClientRating } from '../../api/client';

const base: AitoClientRating = {
  tier: 'good', reason: 'punctual',
  settled_count: 12, on_time_count: 12, overdue_count: 0, past_due_count: 0,
  worst_overdue_days: 0, worst_overdue_number: null, is_company: false,
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


  it('explains an overdue rating with the count, the worst delay and its number', () => {
    render(
      <ClientRatingPill
        rating={{ ...base, tier: 'bad', reason: 'overdue', overdue_count: 2, worst_overdue_days: 23, worst_overdue_number: 'FA-26-4321' }}
      />,
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('2 invoices overdue · worst 23 days, FA-26-4321');
    expect(screen.getByRole('tooltip')).toHaveTextContent(/checked 12m ago/);
  });

  it('says when the company profile scored the figures, and only then', () => {
    const { rerender } = render(<ClientRatingPill rating={{ ...base, is_company: true }} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Good — 12 of 12 invoices paid on time · rated as a company · checked');
    rerender(<ClientRatingPill rating={{ ...base, is_company: false }} />);
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(/rated as a company/);
  });

  it('explains a single overdue invoice in the singular', () => {
    render(
      <ClientRatingPill
        rating={{ ...base, tier: 'bad', reason: 'overdue', overdue_count: 1, worst_overdue_days: 23, worst_overdue_number: 'FA-26-4321' }}
      />,
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('1 invoice overdue · worst 23 days, FA-26-4321');
  });

  it('drops the dangling comma when no invoice number is known', () => {
    render(
      <ClientRatingPill
        rating={{
          ...base,
          tier: 'bad',
          reason: 'overdue',
          overdue_count: 2,
          worst_overdue_days: 23,
          worst_overdue_number: null,
          is_company: false,
          computed_at: null,
        }}
      />,
    );
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toContain('worst 23 days');
    expect(tooltip.textContent?.trim().endsWith(', ')).toBe(false);
    expect(tooltip.textContent?.trim().endsWith(',')).toBe(false);
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

  it('unfolds its width on arrival, with the tooltip inside the clip', () => {
    // The pill lands seconds after the client beside a flexing input, so it
    // opens from a zero-width grid track (`.aito-unfold-x`, index.css) rather
    // than jumping the input narrower. The role=img pill and its tooltip
    // wrapper sit inside the track's single item.
    render(<ClientRatingPill rating={base} className="ml-1" />);
    const unfold = screen.getByTestId('client-rating-unfold');
    expect(unfold).toHaveClass('aito-unfold-x', 'ml-1');
    expect(unfold.children).toHaveLength(1);
    expect(unfold.firstElementChild).toContainElement(screen.getByRole('img'));
  });

  it('exposes the tier word through the tooltip as well', () => {
    render(<ClientRatingPill rating={base} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^Good — 12 of 12 invoices paid on time/);
  });
});

describe('ClientRatingRing', () => {
  const glyph = <svg data-testid="glyph" aria-hidden="true" />;

  it('passes the glyph through untouched while loading, when Books had nothing to say, and for a new client', () => {
    const { container, rerender } = render(<ClientRatingRing rating={undefined}>{glyph}</ClientRatingRing>);
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
    expect(container.querySelector('[data-tier]')).toBeNull();
    rerender(<ClientRatingRing rating={{ ...base, tier: 'unavailable', reason: null }}>{glyph}</ClientRatingRing>);
    expect(container.querySelector('[data-tier]')).toBeNull();
    rerender(<ClientRatingRing rating={{ ...base, tier: 'new', reason: 'new' }}>{glyph}</ClientRatingRing>);
    expect(container.querySelector('[data-tier]')).toBeNull();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it.each(['good', 'medium', 'bad'] as const)('rings the glyph for a %s client and names the tier for assistive tech', (tier) => {
    const { container } = render(<ClientRatingRing rating={{ ...base, tier }}>{glyph}</ClientRatingRing>);
    const ring = container.querySelector('[data-tier]');
    expect(ring).toHaveAttribute('data-tier', tier);
    expect(ring).toContainElement(screen.getByTestId('glyph'));
    expect(ring).toHaveAttribute('role', 'img');
    expect(ring).toHaveAccessibleName(/^Client rating: (Good|Medium|Bad)\. 12 of 12 invoices paid on time/);
    // No visible word — the tier is colour on the ring, text in the tooltip.
    expect(ring).toHaveTextContent('');
    expect(screen.getByRole('tooltip')).toHaveTextContent(/^(Good|Medium|Bad) — 12 of 12 invoices paid on time · checked 12m ago$/);
  });

  it('dims a stale ring and says why in the tooltip', () => {
    const { container } = render(<ClientRatingRing rating={{ ...base, stale: true }}>{glyph}</ClientRatingRing>);
    expect(container.querySelector('[data-tier]')).toHaveAttribute('data-stale', 'true');
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Books unreachable — last known rating · Good — /);
  });
});
