import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Tooltip } from '../../components/Tooltip';

describe('Tooltip', () => {
  it('centres on its trigger by default', () => {
    render(
      <Tooltip content="Why not">
        <button type="button">Go</button>
      </Tooltip>,
    );
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Why not');
    expect(tip.className).toContain('left-1/2');
    expect(tip.style.transform).toContain('-50%');
  });

  it('hangs from its right edge when align="end", for triggers at a clipped edge', () => {
    render(
      <Tooltip content="Why not" align="end">
        <button type="button">Go</button>
      </Tooltip>,
    );
    const tip = screen.getByRole('tooltip');
    expect(tip.className).toContain('right-0');
    expect(tip.className).not.toContain('left-1/2');
    expect(tip.style.transform).not.toContain('-50%');
  });
});

describe('Tooltip inside an outer group', () => {
  it('only reveals on its OWN trigger, not when any ancestor `.group` is hovered', () => {
    // TaskRow's card is a `group` (its remove icon reveals on row hover). Two
    // tooltips inside one card must not both light up when the card is
    // hovered, so the reveal is keyed to a named group the Tooltip owns.
    render(
      <div className="group">
        <Tooltip content="A">
          <button type="button">One</button>
        </Tooltip>
      </div>,
    );
    const tip = screen.getByRole('tooltip');
    const root = tip.parentElement!;
    expect(root.className).toContain('group/tip');
    expect(tip.className).toContain('group-hover/tip:opacity-100');
    expect(tip.className).toContain('group-focus-visible/tip:opacity-100');
    expect(tip.className).not.toMatch(/(^|\s)group-hover:opacity-100/);
  });
});
