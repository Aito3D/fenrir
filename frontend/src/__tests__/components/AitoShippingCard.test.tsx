import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ShippingCard } from '../../components/aito/ShippingCard';
import type { AitoProject } from '../../api/client';

const shipped = {
  id: 7,
  shipping_island: 'rangiroa',
  shipping_service: 'tuamotu',
  shipping_service_name: 'Livraison Avion Tuamotu',
  shipping_first_name: 'Jean-Pierre',
  shipping_last_name: 'DUPONT',
  shipping_phone: '+689-89645864',
  shipping_price: 3200,
} as unknown as AitoProject;

const unshipped = { id: 7, shipping_island: null } as unknown as AitoProject;

describe('ShippingCard', () => {
  it('shows every fact about the shipment', () => {
    render(<ShippingCard project={shipped} currency="XPF" />);
    expect(screen.getByText('Rangiroa')).toBeInTheDocument();
    expect(screen.getByText('Jean-Pierre DUPONT')).toBeInTheDocument();
    expect(screen.getByText('+689-89645864')).toBeInTheDocument();
    expect(screen.getByText('Livraison Avion Tuamotu')).toBeInTheDocument();
    expect(screen.getByText(/3\s?200/)).toBeInTheDocument();
  });

  it('offers only an add button when there is no shipment', () => {
    render(<ShippingCard project={unshipped} currency="XPF" />);
    expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument();
    expect(screen.queryByText(/^shipping$/i)).not.toBeInTheDocument();
  });

  it('opens the same four fields on edit', async () => {
    render(<ShippingCard project={shipped} currency="XPF" />);
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    expect(screen.getByLabelText(/destination island/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/recipient first name/i)).toHaveValue('Jean-Pierre');
  });
});
