/**
 * The printer card warns when slicer-sent jobs cannot reach the card
 * (external_storage_warning): "store_off" when the printer's "Store sent files
 * on external storage" is off, "no_media" when the slot is empty. Either way
 * Bambu Studio prints on an H2 archive as a bare name.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const printer = (id: number, name: string, model: string) => ({
  id,
  name,
  ip_address: `192.168.50.${id}`,
  serial_number: `SERIAL${id}`,
  access_code: '12345678',
  model,
  enabled: true,
  is_active: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'hardened_steel',
  location: null,
  auto_archive: true,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});

const status = (warning: string | null) => ({
  connected: true,
  state: 'IDLE',
  awaiting_plate_clear: false,
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  vt_tray: [],
  external_storage_warning: warning,
});

const WARNINGS: Record<number, string | null> = { 1: 'store_off', 2: 'no_media', 3: null };

describe('PrintersPage external storage warning', () => {
  beforeEach(() => {
    localStorage.removeItem('printerCardSize');
    server.use(
      http.get('/api/v1/printers/', () =>
        HttpResponse.json([printer(1, 'H2C05', 'H2C'), printer(2, 'X2D01', 'X2D'), printer(3, 'H2C01', 'H2C')])
      ),
      http.get('/api/v1/printers/:id/status', ({ params }) =>
        HttpResponse.json(status(WARNINGS[Number(params.id)] ?? null))
      ),
      http.get('/api/v1/settings/ui-preferences', () => HttpResponse.json({ require_plate_clear: false })),
      http.get('/api/v1/queue/', () => HttpResponse.json([]))
    );
  });

  it('names the setting when it is off', async () => {
    render(<PrintersPage />);

    const chip = await screen.findByText('Card storage off');
    expect(chip.closest('[title]')?.getAttribute('title')).toMatch(/Store sent files on external storage/);
  });

  it('asks for a card when the slot is empty', async () => {
    render(<PrintersPage />);

    const chip = await screen.findByText('No card');
    expect(chip.closest('[title]')?.getAttribute('title')).toMatch(/Insert/);
  });

  it('says nothing for a printer that is set up', async () => {
    render(<PrintersPage />);

    await waitFor(() => expect(screen.getByText('H2C01')).toBeInTheDocument());
    await screen.findByText('No card');
    expect(screen.getAllByText('Card storage off')).toHaveLength(1);
    expect(screen.getAllByText('No card')).toHaveLength(1);
  });
});
