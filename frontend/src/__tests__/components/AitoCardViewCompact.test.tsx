import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { CardView } from '../../components/aito/CardView';
import { makeProject } from '../fixtures/aitoProject';

const company = makeProject({ client_name: 'SAS ONATI', client_is_company: true, client_contact_name: 'Jeffrey' });

describe('CardView compact', () => {
  it('puts the contact inline after the client and drops its own line', () => {
    render(<CardView project={company} onExpand={() => {}} compact />);
    expect(screen.getByTestId('aito-card-contact-inline')).toHaveTextContent('Jeffrey');
    expect(screen.queryByTestId('aito-card-contact')).toBeNull();
  });

  it('renders no grip, not even the inert one', () => {
    const { container } = render(<CardView project={company} onExpand={() => {}} compact />);
    expect(container.querySelector('.lucide-grip-vertical')).toBeNull();
  });

  it('is unchanged without compact', () => {
    const { container } = render(<CardView project={company} onExpand={() => {}} />);
    expect(screen.getByTestId('aito-card-contact')).toHaveTextContent('Jeffrey');
    expect(screen.queryByTestId('aito-card-contact-inline')).toBeNull();
    expect(container.querySelector('.lucide-grip-vertical')).not.toBeNull();
  });
});
