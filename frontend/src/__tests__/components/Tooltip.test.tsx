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
