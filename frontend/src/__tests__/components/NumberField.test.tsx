import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NumberField } from '../../components/NumberField';

describe('NumberField warning', () => {
  it('shows an amber note when a warning is given and there is no error', () => {
    render(<NumberField id="x" label="X" value="1" onChange={() => {}} warning="Curve is flat" />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Curve is flat');
    expect(note).toHaveClass('text-amber-400');
    expect(screen.getByLabelText('X')).toHaveAttribute('aria-invalid', 'false');
  });
  it('lets the error win over the warning', () => {
    render(<NumberField id="x" label="X" value="1" onChange={() => {}} warning="soft" error="hard" />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByText('hard')).toBeInTheDocument();
  });
});
