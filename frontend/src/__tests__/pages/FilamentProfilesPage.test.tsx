/**
 * Tests for the Filament Profiles page shell (Task 11): filters, grid,
 * import/export/sync flows and the two sync modals.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FilamentProfilesPage } from '../../pages/FilamentProfilesPage';
import { readMaterialFilter, writeMaterialFilter, readGridSize } from '../../utils/filamentProfilePrefs';
import type { FilamentPreset } from '../../api/client';

function preset(overrides: Partial<FilamentPreset> = {}): FilamentPreset {
  return {
    id: 1,
    name: 'Bambu PLA Basic - Black',
    brand: 'Bambu',
    material: 'PLA',
    color: 'Black',
    color_hex: '#000000',
    filename: 'bambu_pla_basic_black.json',
    content: '{}',
    ...overrides,
  };
}

const PRESETS: FilamentPreset[] = [
  preset(),
  preset({
    id: 2,
    name: 'SUNLU PETG - White',
    brand: 'SUNLU',
    material: 'PETG',
    color: 'White',
    color_hex: '#ffffff',
    filename: 'sunlu_petg_white.json',
    content: '{}',
  }),
];

function stubBase() {
  server.use(
    http.get('*/filament-profiles', () => HttpResponse.json(PRESETS)),
    http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
    http.get('*/filament-catalog/', () => HttpResponse.json([])),
  );
}

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
});

describe('FilamentProfilesPage', () => {
  it('renders cards after load', async () => {
    stubBase();
    render(<FilamentProfilesPage />);

    // "White"/"Black" are each preset's color label, shown only in the card
    // body (brand names like "SUNLU"/"Bambu" also appear in the brand-pill
    // row, so asserting on those would match more than one element).
    expect(await screen.findByText('White')).toBeInTheDocument();
    expect(screen.getByText('Black')).toBeInTheDocument();
  });

  it('filters the grid by brand pill and persists the choice', async () => {
    stubBase();
    render(<FilamentProfilesPage />);

    await screen.findByText('White');

    const sunluPill = screen.getByRole('button', { name: 'SUNLU' });
    await userEvent.click(sunluPill);

    await waitFor(() => expect(screen.queryByText('Black')).not.toBeInTheDocument());
    expect(screen.getByText('White')).toBeInTheDocument();
    expect(localStorage.getItem('profiles-filter-brand')).toBe('SUNLU');
  });

  it('does not clear a persisted material filter while loading or before presets arrive', async () => {
    writeMaterialFilter('PETG');
    server.use(
      http.get('*/filament-profiles', async () => {
        await delay(50);
        return HttpResponse.json(PRESETS);
      }),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
    );

    render(<FilamentProfilesPage />);

    // Still loading — the persisted filter must survive untouched.
    expect(readMaterialFilter()).toBe('PETG');

    await screen.findByText('White');
    // After real (non-empty) data arrives, PETG is a valid material so it
    // stays selected — never auto-cleared.
    expect(readMaterialFilter()).toBe('PETG');
  });

  it('imports new files sequentially, skipping ones that already exist', async () => {
    stubBase();
    const createCalls: string[] = [];
    server.use(
      http.get('*/filament-profiles/bambu-scan', () =>
        HttpResponse.json({
          files: [
            { filename: 'bambu_pla_basic_black.json', content: '{}' },
            {
              filename: 'new_one.json',
              content: JSON.stringify({
                name: 'New One',
                filament_vendor: ['Generic'],
                filament_type: ['PLA'],
                filament_colour: ['#123456'],
              }),
            },
          ],
        }),
      ),
      http.post('*/filament-profiles', async ({ request }) => {
        const body = (await request.json()) as { filename: string };
        createCalls.push(body.filename);
        return HttpResponse.json(preset({ id: 99, filename: body.filename }));
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }));

    await waitFor(() => expect(createCalls).toEqual(['new_one.json']));
    expect(await screen.findByText(/Imported 1 preset/i)).toBeInTheDocument();
  });

  it('shows dry-run stats including Removed, and only executes after confirming Sync', async () => {
    stubBase();
    let dryRunCalls = 0;
    let executeCalls = 0;
    server.use(
      http.post('*/filament-profiles/bambu-sync', async ({ request }) => {
        const body = (await request.json()) as { dry_run: boolean };
        if (body.dry_run) {
          dryRunCalls += 1;
          return HttpResponse.json({ stats: { added: 1, updated: 2, removed: 3, unchanged: 4 } });
        }
        executeCalls += 1;
        return HttpResponse.json({ stats: { added: 1, updated: 2, removed: 0, unchanged: 6 } });
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(screen.getByRole('button', { name: /Sync to PC/i }));

    await waitFor(() => expect(dryRunCalls).toBe(1));
    expect(executeCalls).toBe(0);

    await screen.findByRole('heading', { name: /Sync to PC/i });
    const modal = screen.getByTestId('sync-modal');
    expect(within(modal).getByText('3')).toBeInTheDocument(); // Removed count

    await userEvent.click(screen.getByRole('button', { name: /^Sync$/ }));

    await waitFor(() => expect(executeCalls).toBe(1));
    expect(await screen.findByRole('heading', { name: /Sync complete/i })).toBeInTheDocument();
  });

  it('disables Export ZIP when no preset has both filename and content, and grid-size buttons persist', async () => {
    server.use(
      http.get('*/filament-profiles', () =>
        HttpResponse.json([preset({ filename: '', content: '' })]),
      ),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
    );
    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    expect(screen.getByRole('button', { name: /Export ZIP/i })).toBeDisabled();

    const gridButtons = screen.getAllByRole('button', { name: /grid size|small|medium|large/i });
    expect(gridButtons.length).toBeGreaterThanOrEqual(3);
    await userEvent.click(gridButtons[0]);
    expect(readGridSize()).toBe('small');
  });
});
