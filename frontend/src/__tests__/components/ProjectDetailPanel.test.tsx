import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { ProjectDetailPanel } from '../../components/aito/ProjectDetailPanel';
import type { AitoProject } from '../../api/client';

const project: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
  client_is_company: true,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

const show = (overrides: Partial<AitoProject> = {}) =>
  render(<ProjectDetailPanel project={{ ...project, ...overrides }} onClose={vi.fn()} />);

describe('ProjectDetailPanel client fields', () => {
  it('titles the panel with the project reference, not the client', () => {
    show();
    expect(screen.getByRole('heading')).toHaveTextContent(/Project #12|Projet n°12/);
  });

  it('still names the dialog after the client for assistive technology', () => {
    show();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('ACME SARL');
  });

  it('labels a company client as Company name', () => {
    show();
    expect(screen.getByText(/company name/i)).toBeInTheDocument();
    expect(screen.queryByText(/^client name/i)).not.toBeInTheDocument();
  });

  it('labels a person client as Client name', () => {
    show({ client_is_company: false, client_name: 'Paul THEIS' });
    expect(screen.getByText(/client name/i)).toBeInTheDocument();
    expect(screen.queryByText(/company name/i)).not.toBeInTheDocument();
  });

  it('labels a legacy card with a null flag as Client name', () => {
    show({ client_is_company: null });
    expect(screen.getByText(/client name/i)).toBeInTheDocument();
  });

  it('labels the phone and email, and keeps their links', () => {
    show();
    expect(screen.getByText(/phone/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+689-87123456' })).toHaveAttribute(
      'href',
      'tel:+689-87123456',
    );
    expect(screen.getByRole('link', { name: 'hi@acme.pf' })).toHaveAttribute(
      'href',
      'mailto:hi@acme.pf',
    );
  });

  it('omits a field entirely when it has no value', () => {
    show({ client_email: null });
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });
});
