/** The archive card's rows for a sliced file that is not printed yet: calculator costs and price,
 *  layers, objects, material and colours; nothing when the file carries none of them. */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { PrintFacts } from '../../components/PrintFacts';
import type { CalcConfig } from '../../utils/archivePricing';

const calcConfig: CalcConfig = {
  filaments: [{ id: 1, name: 'PETG basique', brand: '', material: 'PETG', cost_per_kg: 3731, sale_price_per_kg: 5596.5, difficulty_pct: 150 }],
  printers: [{ id: 1, name: 'X1C', purchase_price: 347000, lifetime_years: 2, daily_usage_hours: 5, power_watts: 400, repair_rate_pct: 30 }],
  defaults: {
    electricity_tariff: 120, labor_rate_per_hour: 3000, consumables_packaging_flat: 30, failure_rate_pct: 30,
    prototype_rate_pct: 30, ads_rate_pct: 5, filament_markup_pct: 5, global_markup_pct: 50, tax_pct: 13,
    default_difficulty_pct: 100, stuff_markup_pct: 20,
  } as CalcConfig['defaults'],
};

const facts = {
  print_time_seconds: 8040, filament_used_grams: 38.4, filament_type: 'PETG', filament_color: '#ff0000,#00ff00',
  sliced_for_model: 'X1C', total_layers: 320, layer_height: 0.2, object_count: 2,
};

describe('PrintFacts', () => {
  it('shows the calculator costs and price, layers, objects, material and colours', () => {
    render(<PrintFacts facts={facts} calcConfig={calcConfig} currencyCode="XPF" />);
    expect(screen.getByTestId('print-facts-machine-cost')).toHaveAttribute('title', 'Machine cost');
    expect(screen.queryByTestId('print-facts-energy-cost')).not.toBeInTheDocument();
    expect(screen.getByTestId('print-facts-price')).toHaveAttribute('title', expect.stringContaining('X1C'));
    for (const id of ['print-facts-machine-cost', 'print-facts-price']) {
      expect(screen.getByTestId(id).textContent).toMatch(/\d/);
    }
    expect(screen.getByTestId('print-facts-layers')).toHaveTextContent('320 layers');
    expect(screen.getByTestId('print-facts-layers')).toHaveTextContent('0.2mm');
    expect(screen.getByTestId('print-facts-objects')).toHaveTextContent('2 objects');
    const material = screen.getByTestId('print-facts-material');
    expect(material).toHaveTextContent('PETG');
    expect(material.querySelectorAll('[title="#ff0000"], [title="#00ff00"]')).toHaveLength(2);
  });

  it('hides the cost rows without a calculator, and the material name when the caller shows it', () => {
    render(<PrintFacts facts={facts} calcConfig={null} currencyCode="XPF" omitMaterialType />);
    expect(screen.queryByTestId('print-facts-price')).not.toBeInTheDocument();
    expect(screen.getByTestId('print-facts-layers')).toBeInTheDocument();
    expect(screen.getByTestId('print-facts-material')).not.toHaveTextContent('PETG');
    expect(screen.getByTestId('print-facts-material').querySelectorAll('[title^="#"]')).toHaveLength(2);
  });

  it('renders nothing for a file with no facts (a source .3mf)', () => {
    render(<PrintFacts facts={{ print_time_seconds: null, filament_used_grams: null, filament_type: null }} calcConfig={calcConfig} currencyCode="XPF" />);
    expect(screen.queryByTestId('print-facts')).not.toBeInTheDocument();
  });
});
