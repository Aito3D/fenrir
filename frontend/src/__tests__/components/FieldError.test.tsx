import { describe, expect, it } from 'vitest';
import { render, screen } from '../utils';
import { FieldError } from '../../components/aito/FieldError';

describe('FieldError', () => {
  it('rises in when a message is revealed', () => {
    render(<FieldError messageKey="aito.phoneRequired" />);
    expect(screen.getByRole('alert')).toHaveClass('animate-rise');
  });

  it('renders nothing without a message', () => {
    render(<FieldError messageKey={null} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
