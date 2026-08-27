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

  it('imports new files strictly sequentially, in file order, skipping ones that already exist', async () => {
    stubBase();
    const createCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    server.use(
      http.get('*/filament-profiles/bambu-scan', () =>
        HttpResponse.json({
          files: [
            // Already exists (matches a loaded preset's filename) — must be skipped.
            { filename: 'bambu_pla_basic_black.json', content: '{}' },
            {
              filename: 'new_one.json',
              content: JSON.stringify({
                name: 'New One',
                filament_vendor: ['Generic'],
                filament_type: ['PLA'],
                filament_colour: ['#111111'],
              }),
            },
            {
              filename: 'new_two.json',
              content: JSON.stringify({
                name: 'New Two',
                filament_vendor: ['Generic'],
                filament_type: ['PETG'],
                filament_colour: ['#222222'],
              }),
            },
            {
              filename: 'new_three.json',
              content: JSON.stringify({
                name: 'New Three',
                filament_vendor: ['Generic'],
                filament_type: ['ABS'],
                filament_colour: ['#333333'],
              }),
            },
          ],
        }),
      ),
      http.post('*/filament-profiles', async ({ request }) => {
        // Tracks concurrency: if the page ever fires the next POST before
        // this one resolves, `maxInFlight` catches it.
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const body = (await request.json()) as { filename: string };
        await delay(20);
        createCalls.push(body.filename);
        inFlight -= 1;
        return HttpResponse.json(preset({ id: 100 + createCalls.length, filename: body.filename }));
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }));

    await waitFor(() =>
      expect(createCalls).toEqual(['new_one.json', 'new_two.json', 'new_three.json']),
    );
    expect(maxInFlight).toBe(1);
    expect(await screen.findByText(/Imported 3 preset/i)).toBeInTheDocument();
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

  it('syncs prices from Zoho and reports what needs attention', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 2,
          unchanged: 1,
          attention: [{ id: 7, name: 'eSUN PETG', reason: 'ambiguous', candidates: ['A', 'B'] }],
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Anchored so this only matches the below-the-fold summary panel's own
    // text and not the toast (T-008: the toast now appends its own
    // needs-attention count onto the same "Priced N, unchanged N" prefix).
    expect(await screen.findByText(/^Priced 2, unchanged 1$/i, {}, { timeout: 5000 })).toBeInTheDocument();
    // The needs-attention list is the safety property made visible — without it
    // auto-matching would be silently lossy.
    expect(await screen.findByText(/eSUN PETG/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/several items matched/i, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('reports a matched preset with unwritable content as needing attention, not as unchanged', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 9, name: 'Broken PLA', reason: 'unwritable_content', candidates: [] }],
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Must render its own reason, never fall through to the "no price" copy
    // (a matched item with unreadable content is a different problem).
    expect(await screen.findByText(/Broken PLA/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      await screen.findByText(/preset's saved data is empty or unreadable/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the item has no price/i)).not.toBeInTheDocument();
  });

  it('reports a matched preset with a bad upstream price as needing attention, not unwritable content', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 11, name: 'Infinite PLA', reason: 'bad_price', candidates: [] }],
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Must render its own reason and never fall through to another reason's
    // copy: a bad upstream price is not the same problem as an unreadable
    // preset file or a missing price.
    expect(await screen.findByText(/Infinite PLA/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      await screen.findByText(/item's price is invalid or unusably large/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the item has no price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/preset's saved data is empty or unreadable/i)).not.toBeInTheDocument();
  });

  it('reports a preset with no matching Zoho item as needing attention', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 8, name: 'Generic ABS', reason: 'no_match', candidates: [] }],
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Must render the "no matching item" copy and never fall through to a
    // different reason's copy (this is the ternary's true-branch, which is
    // otherwise never exercised).
    expect(await screen.findByText(/Generic ABS/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/no matching item in zoho/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/the item has no price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/several items matched/i)).not.toBeInTheDocument();
  });

  it('reports a matched preset with no price as needing attention', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 12, name: 'Unpriced PLA', reason: 'no_price', candidates: [] }],
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Must render the "no price" copy — the ternary's final fallback branch,
    // which is otherwise never exercised and could silently swallow any
    // unhandled or wrong reason string.
    expect(await screen.findByText(/Unpriced PLA/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      await screen.findByText(/matched, but the item has no price/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/no matching item in zoho/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/several items matched/i)).not.toBeInTheDocument();
  });

  it('reports the needs-attention count in the toast and downgrades it off success when some profiles need attention (T-008)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 2,
          unchanged: 1,
          attention: [
            { id: 7, name: 'eSUN PETG', reason: 'ambiguous', candidates: ['A', 'B'] },
            { id: 8, name: 'Generic ABS', reason: 'no_match', candidates: [] },
          ],
        }),
      ),
    );

    const { container } = render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // The toast (not the below-the-fold summary panel) must itself carry the
    // needs-attention count: "Priced 2, unchanged 1" alone would read as a
    // full success even though 2 profiles were left unresolved.
    const toastViewport = container.querySelector('[data-testid="toast-viewport"]') as HTMLElement;
    const toastText = await within(toastViewport).findByText(/priced 2, unchanged 1/i, {}, { timeout: 5000 });
    expect(toastText.textContent).toMatch(/2 need attention/i);

    // ... and it must not render as the green "success" toast.
    const toastShell = toastText.closest('.toast-slide') as HTMLElement;
    expect(toastShell.className).not.toMatch(/border-green-500/);
    expect(toastShell.className).toMatch(/border-yellow-500/);
  });

  it('downgrades the toast off success when a sync prices and changes nothing at all (T-008)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [],
        }),
      ),
    );

    const { container } = render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // A run that priced and changed nothing is not a success, even with an
    // empty attention list — it must not show the green "success" toast.
    const toastViewport = container.querySelector('[data-testid="toast-viewport"]') as HTMLElement;
    const toastText = await within(toastViewport).findByText(/priced 0, unchanged 0/i, {}, { timeout: 5000 });
    const toastShell = toastText.closest('.toast-slide') as HTMLElement;
    expect(toastShell.className).not.toMatch(/border-green-500/);
    expect(toastShell.className).toMatch(/border-yellow-500/);
  });

  it('shows the backend error message when the Zoho sync fails', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({ detail: 'Zoho API rate limit exceeded' }, { status: 502 }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Real safety property: the toast must surface the backend's own detail
    // message (the `error instanceof Error` branch), not the generic
    // fallback string — if the ternary's branches were swapped, this
    // specific text would never appear and the generic fallback would show
    // in its place instead.
    expect(
      await screen.findByText(/zoho api rate limit exceeded/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not sync prices from zoho/i)).not.toBeInTheDocument();
  });

  it('clears the previous run summary panel when a later sync fails', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 12,
          unchanged: 3,
          attention: [{ id: 7, name: 'eSUN PETG', reason: 'ambiguous', candidates: ['A', 'B'] }],
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));
    // Anchored so this only matches the below-the-fold summary panel's own
    // text and not the toast (T-008: the toast now appends its own
    // needs-attention count onto the same "Priced N, unchanged N" prefix).
    expect(await screen.findByText(/^Priced 12, unchanged 3$/i, {}, { timeout: 5000 })).toBeInTheDocument();

    // A later sync fails — the stale "Priced 12, unchanged 3" panel from the
    // first run must not linger once the toast reports the failure; the
    // page must not assert a successful sync that did not happen.
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({ detail: 'Zoho API rate limit exceeded' }, { status: 502 }),
      ),
    );

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    await screen.findByText(/zoho api rate limit exceeded/i, {}, { timeout: 5000 });
    // Anchored to the panel's exact text (T-008 gave the toast its own,
    // longer "...— N need attention" text, and its dismiss window is now
    // longer too since it's a warning toast — the still-fading first toast
    // must not make this assertion about the panel flaky).
    await waitFor(
      () => expect(screen.queryByText(/^Priced 12, unchanged 3$/i)).not.toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.queryByText(/eSUN PETG/i)).not.toBeInTheDocument();
  });

  it('re-syncs the open editor with fresh data when a Zoho sync updates the preset underneath it', async () => {
    // The GET handler answers differently before/after the sync — this
    // stands in for "the Zoho price sync just wrote a new filament_cost and
    // invalidated ['filamentPresets']" (T-006): a still-open editor must
    // pick up the refetched content, not keep showing the pre-sync snapshot
    // it was opened with.
    let getCalls = 0;
    server.use(
      http.get('*/filament-profiles', () => {
        getCalls += 1;
        const primed = preset({
          content: getCalls === 1 ? '{"filament_cost":["10"]}' : '{"filament_cost":["25"]}',
          updated_at: getCalls === 1 ? '2026-08-01T00:00:00Z' : '2026-08-25T00:00:00Z',
        });
        return HttpResponse.json([primed, PRESETS[1]]);
      }),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({ priced: 1, unchanged: 1, attention: [] }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    // Open the editor on the preset the sync is about to reprice.
    await userEvent.click(screen.getByText('Black'));
    expect(
      await screen.findByRole('spinbutton', { name: /cost/i }, { timeout: 5000 }),
    ).toHaveValue(10);

    // Run the sync while the editor is still open — this is the
    // invalidateQueries(['filamentPresets']) call in handleZohoSync.
    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));
    await screen.findByText(/priced 1/i, {}, { timeout: 5000 });

    // The still-open editor must reflect the refetched preset, not the
    // pre-sync snapshot it was opened with.
    await waitFor(
      () => expect(screen.getByRole('spinbutton', { name: /cost/i })).toHaveValue(25),
      { timeout: 5000 },
    );
  });
});
