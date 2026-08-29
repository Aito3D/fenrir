/**
 * Tests for the Filament Profiles page shell (Task 11): filters, grid,
 * import/export/sync flows and the two sync modals.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FilamentProfilesPage } from '../../pages/FilamentProfilesPage';
import { readMaterialFilter, writeMaterialFilter, readGridSize } from '../../utils/filamentProfilePrefs';
import type { FilamentPreset } from '../../api/client';
import { setAuthToken } from '../../api/client';

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
  setAuthToken(null);
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

  it('T-026: still shows the dry-run preview but disables Sync for a user without filaments:delete', async () => {
    // The confirm step runs the destructive non-dry-run sync, which the
    // backend now also gates on filaments:delete on top of filaments:update.
    // A user holding only filaments:update must see the preview (dry-run
    // stays allowed) but must not be able to hit the confirm button and get
    // a blind 403.
    stubBase();
    setAuthToken('test-token', 'session');
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({
          id: 9,
          username: 'update-only',
          is_admin: false,
          permissions: ['filaments:read', 'filaments:update'],
        }),
      ),
      http.post('*/filament-profiles/bambu-sync', async ({ request }) => {
        const body = (await request.json()) as { dry_run: boolean };
        expect(body.dry_run).toBe(true); // the execute call must never fire
        return HttpResponse.json({ stats: { added: 0, updated: 0, removed: 1, unchanged: 0 } });
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(screen.getByRole('button', { name: /Sync to PC/i }));
    await screen.findByRole('heading', { name: /Sync to PC/i });

    const syncButton = screen.getByRole('button', { name: /^Sync$/ });
    expect(syncButton).toBeDisabled();
    expect(screen.getByText(/do not have permission to delete existing presets/i)).toBeInTheDocument();
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
          attention_total: 1,
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

  it('caps a large ambiguous collision to 5 names plus a "+N more" remainder (T-010)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [
            {
              id: 7,
              name: 'eSUN PETG',
              reason: 'ambiguous',
              candidates: ['A', 'B', 'C', 'D', 'E'],
              candidates_total: 7,
            },
          ],
          attention_total: 1,
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    expect(await screen.findByText(/eSUN PETG/i, {}, { timeout: 5000 })).toBeInTheDocument();
    // Only the 5 shipped names are shown, plus a "+2 more" remainder for the
    // two collisions that did not fit — never the full unbounded list.
    expect(await screen.findByText(/A, B, C, D, E/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/\+2 more/i, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('shows an "and N more" remainder below the attention list when attention_total exceeds the shipped entries (T-038)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 7, name: 'eSUN PETG', reason: 'no_match', candidates: [] }],
          attention_total: 52,
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // The headline count reflects the true total, not just the shipped list.
    // Anchored so this only matches the below-the-fold summary panel's own
    // text and not the toast, which appends the same count to its own
    // "Priced N, unchanged N" prefix.
    expect(await screen.findByText(/^52 need attention$/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/eSUN PETG/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/\+51 more/i, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('renders no "and N more" remainder when attention_total equals the shipped entries (T-038)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 7, name: 'eSUN PETG', reason: 'no_match', candidates: [] }],
          attention_total: 1,
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    expect(await screen.findByText(/^1 need attention$/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/eSUN PETG/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/more$/i)).not.toBeInTheDocument();
  });

  it('reports a matched preset with unwritable content as needing attention, not as unchanged', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 9, name: 'Broken PLA', reason: 'unwritable_content', candidates: [] }],
          attention_total: 1,
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
          attention_total: 1,
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
          attention_total: 1,
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
          attention_total: 1,
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

  it('reports a matched preset with an unknown spool weight as needing attention, not as priced', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [
            {
              id: 13,
              name: 'Mystery PETG',
              reason: 'weight_unknown',
              candidates: ['Generic - PETG - Black - 1.75mm'],
              candidates_total: 1,
            },
          ],
          attention_total: 1,
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Must render its own reason, never fall through to the "no price" copy
    // (a matched item whose price was derived from an assumed weight is a
    // different problem, and a name-inferred weight could silently re-scale
    // the price on a later rename).
    expect(await screen.findByText(/Mystery PETG/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      await screen.findByText(/spool weight is unknown/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/matched, but the item has no price/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Generic - PETG - Black - 1\.75mm/)).toBeInTheDocument();
  });

  it('reports a matched preset whose re-formatted content would exceed the size cap as needing attention, not as priced', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 0,
          unchanged: 0,
          attention: [{ id: 14, name: 'Huge PLA', reason: 'content_too_large', candidates: [] }],
          attention_total: 1,
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Must render its own reason, never fall through to the "no price" copy
    // (T-044, user-approved 2026-08-27): a preset whose re-indented content
    // would cross the size cap is left unpriced and reported here instead.
    expect(await screen.findByText(/Huge PLA/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      await screen.findByText(/re-formatted content would exceed the size limit/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/matched, but the item has no price/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/preset's saved data is empty or unreadable/i)).not.toBeInTheDocument();
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
          attention_total: 2,
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
          attention_total: 0,
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

  it('discloses a stale catalogue instead of reporting a plain success (T-034)', async () => {
    stubBase();
    const staleSince = '2026-08-20T12:00:00Z';
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 2,
          unchanged: 1,
          attention: [],
          attention_total: 0,
          catalogue_stale_since: staleSince,
        }),
      ),
    );

    const { container } = render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Even though the sync itself was otherwise a "full success" (no
    // attention, something priced), a stale catalogue must still not render
    // as the green success toast — the operator must be told the prices came
    // from a cached catalogue, not a live sync.
    const expectedTimestamp = new Date(staleSince).toLocaleString();
    const toastViewport = container.querySelector('[data-testid="toast-viewport"]') as HTMLElement;
    const toastText = await within(toastViewport).findByText(/priced 2, unchanged 1/i, {}, { timeout: 5000 });
    expect(toastText.textContent).toContain(expectedTimestamp);
    const toastShell = toastText.closest('.toast-slide') as HTMLElement;
    expect(toastShell.className).not.toMatch(/border-green-500/);
    expect(toastShell.className).toMatch(/border-yellow-500/);

    // ... and the below-the-fold summary panel carries its own stale notice.
    const panelNotices = await screen.findAllByText((_, el) => (el?.textContent ?? '').includes(expectedTimestamp), {
      timeout: 5000,
    });
    expect(panelNotices.length).toBeGreaterThan(0);
  });

  it('keeps the green success toast for a fresh sync with nothing left to disclose (T-034)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 2,
          unchanged: 1,
          attention: [],
          attention_total: 0,
          catalogue_stale_since: null,
        }),
      ),
    );

    const { container } = render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    const toastViewport = container.querySelector('[data-testid="toast-viewport"]') as HTMLElement;
    const toastText = await within(toastViewport).findByText(/priced 2, unchanged 1/i, {}, { timeout: 5000 });
    const toastShell = toastText.closest('.toast-slide') as HTMLElement;
    // Pin both sides of isFullSuccess's true branch: the green success class
    // must be present, and the yellow warning class it would carry on any
    // false-positive-`isFullSuccess` regression (e.g. `||` typo'd for `&&`,
    // or a broken attentionCount check) must be absent.
    expect(toastShell.className).toMatch(/border-green-500/);
    expect(toastShell.className).not.toMatch(/border-yellow-500/);
  });

  it('shows the backend error message when the Zoho sync fails, and still refetches the presets cache (T-047)', async () => {
    // T-047: an HTTP error *response* (an ApiError, e.g. this 502) is a
    // definite "the server did not apply it" signal, so the toast keeps its
    // specific "failed" wording — but /zoho-sync's write is committed
    // server-side before it can even respond with an error for something
    // unrelated (e.g. a post-write notification failure), so the presets
    // cache must still be invalidated and refetched on this path too.
    let getCalls = 0;
    server.use(
      http.get('*/filament-profiles', () => {
        getCalls += 1;
        return HttpResponse.json(PRESETS);
      }),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({ detail: 'Zoho API rate limit exceeded' }, { status: 502 }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');
    expect(getCalls).toBe(1);

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    // Real safety property: the toast must surface the backend's own detail
    // message (the `error instanceof ApiError` branch), not the generic
    // fallback string — if the ternary's branches were swapped, this
    // specific text would never appear and the generic fallback would show
    // in its place instead.
    expect(
      await screen.findByText(/zoho api rate limit exceeded/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not sync prices from zoho/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sync result unknown/i)).not.toBeInTheDocument();

    // The `finally` block's invalidateQueries(['filamentPresets']) refetches
    // even on this definite-failure path.
    await waitFor(() => expect(getCalls).toBe(2));
  });

  // T-033: the button had no busy indicator at all, unlike the sibling
  // Sync-Base button's Loader2 icon-swap — a slow Zoho sync looked identical
  // to a dead button.
  it('shows a busy spinner and disables the button while a Zoho sync is in flight', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', async () => {
        // Never resolves within this test — stands in for a request still
        // in flight, so the assertions below only see the "syncing" state.
        await delay('infinite');
        return HttpResponse.json({ priced: 0, unchanged: 0, attention: [], attention_total: 0 });
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const button = screen.getByRole('button', { name: /sync prices from zoho/i });
    await userEvent.click(button);

    expect(await screen.findByRole('button', { name: /syncing prices from zoho/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^sync prices from zoho$/i })).not.toBeInTheDocument();
  });

  // T-033: a dropped-without-reset connection left the sync promise
  // unsettled, so `finally { setZohoSyncing(false) }` never ran and the
  // button stayed dead until reload. An AbortController with an explicit
  // deadline now ends the sync with an error toast and re-enables the
  // button instead. Driven entirely with vitest fake timers — never a
  // wall-clock sleep, never msw's `delay()` alone.
  //
  // T-047: /zoho-sync commits its write server-side before it responds, so
  // an aborted request (lost response, not a definite failure) must no
  // longer read as "sync failed" — the toast now reads as an unknown
  // outcome, and the presets cache is invalidated/refetched here too so the
  // grid and any open editor stop serving the pre-sync snapshot.
  it('aborts a Zoho sync that runs past the deadline, shows an unknown-outcome toast, refetches presets, and re-enables the button (T-033, T-047)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let getCalls = 0;
      server.use(
        http.get('*/filament-profiles', () => {
          getCalls += 1;
          return HttpResponse.json(PRESETS);
        }),
        http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
        http.get('*/filament-catalog/', () => HttpResponse.json([])),
        http.post('*/filament-profiles/zoho-sync', async () => {
          // Never resolves on its own — only the client-side abort ends it.
          await delay('infinite');
          return HttpResponse.json({ priced: 0, unchanged: 0, attention: [], attention_total: 0 });
        }),
      );

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<FilamentProfilesPage />);
      await screen.findByText('White');
      expect(getCalls).toBe(1);

      await user.click(screen.getByRole('button', { name: /sync prices from zoho/i }));
      expect(await screen.findByRole('button', { name: /syncing prices from zoho/i })).toBeDisabled();

      // Comfortably inside the 10-minute deadline: still syncing, no toast yet.
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      expect(screen.queryByText(/sync result unknown/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/could not sync prices from zoho/i)).not.toBeInTheDocument();

      // Cross the deadline by the smallest margin — the error toast
      // auto-dismisses after a few seconds, so overshooting here would let
      // it fire and fade before the assertions below ever see it.
      await vi.advanceTimersByTimeAsync(60 * 1000 + 1);

      // Unknown-outcome wording, not the definite "failed" copy — the
      // response was lost, but /zoho-sync may have already committed.
      expect(await screen.findByText(/sync result unknown/i)).toBeInTheDocument();
      expect(screen.queryByText(/^could not sync prices from zoho$/i)).not.toBeInTheDocument();
      expect(await screen.findByRole('button', { name: /^sync prices from zoho$/i })).toBeEnabled();

      // The `finally` block's invalidateQueries(['filamentPresets']) still
      // refetches on this aborted path.
      await waitFor(() => expect(getCalls).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the previous run summary panel when a later sync fails', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 12,
          unchanged: 3,
          attention: [{ id: 7, name: 'eSUN PETG', reason: 'ambiguous', candidates: ['A', 'B'] }],
          attention_total: 1,
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
        HttpResponse.json({ priced: 1, unchanged: 1, attention: [], attention_total: 0 }),
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

  it('closes the editor once Save succeeds, even though the refetch it triggers bumps updated_at (T-031)', async () => {
    // Mirrors what the real PATCH endpoint does: the saved row comes back
    // (and the subsequent GET refetch answers) with a new `updated_at`. That
    // bump feeds the editor's remount key (`${presetId}-${updated_at}`, kept
    // for T-006 below) — on the old code this raced the modal's own 220ms
    // close animation and remounted the modal instance whose deferred
    // onClose was about to fire, so the editor never closed. The previous
    // fixture never set `updated_at` at all, which is exactly why nothing
    // caught it.
    let getCalls = 0;
    server.use(
      http.get('*/filament-profiles', () => {
        getCalls += 1;
        const primed = preset({
          updated_at: getCalls === 1 ? '2026-08-01T00:00:00Z' : '2026-08-25T00:00:00Z',
        });
        return HttpResponse.json([primed, PRESETS[1]]);
      }),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
      http.patch('*/filament-profiles/1', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          preset({ ...body, updated_at: '2026-08-25T00:00:00Z' } as Partial<FilamentPreset>),
        );
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    await userEvent.click(screen.getByText('Black'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('sends the loaded updated_at, and on a 409 keeps the editor open, toasts, and surfaces the T-032 conflict banner (T-045)', async () => {
    // The PATCH the editor issues carries `expected_updated_at`; the server
    // 409s here (as if a concurrent Zoho sync had already bumped the row).
    // The page must not close the editor on this failure (T-031's
    // close-on-save is success-only) but must still invalidate the presets
    // query so the still-open editor's `preset` prop picks up the new
    // `updated_at` and T-032's own banner machinery takes it from there.
    let getCalls = 0;
    let patchBody: Record<string, unknown> | null = null;
    server.use(
      http.get('*/filament-profiles', () => {
        getCalls += 1;
        const primed = preset({
          updated_at: getCalls === 1 ? '2026-08-01T00:00:00Z' : '2026-08-25T00:00:00Z',
        });
        return HttpResponse.json([primed, PRESETS[1]]);
      }),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
      http.patch('*/filament-profiles/1', async ({ request }) => {
        patchBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ detail: 'This preset changed on the server since it was loaded' }, { status: 409 });
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    await userEvent.click(screen.getByText('Black'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    const colorInput = screen.getByRole('textbox', { name: /color label/i });
    await userEvent.clear(colorInput);
    await userEvent.type(colorInput, 'Sunrise');

    await userEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => expect(patchBody).toMatchObject({ expected_updated_at: '2026-08-01T00:00:00Z' }));

    // The invalidate-on-409 refetch lands, and T-032's own conflict banner
    // picks it up — same "changed on the server" copy the toast also uses,
    // so both a toast and the in-dialog alert carry that text; the alert
    // role scopes this assertion to the banner specifically.
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed on the server/i);
    // Also toasted (at least one match outside the dialog's own alert).
    expect((await screen.findAllByText(/changed on the server/i)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The unsaved edit is still held, not discarded by the refetch.
    expect(screen.getByRole('textbox', { name: /color label/i })).toHaveValue('Sunrise');
  });

  it('keeps unsaved edits and shows a conflict banner when a background refetch changes the preset, then adopts the server copy on reload (T-032)', async () => {
    // Same before/after GET shape as the T-006 test above, but this time
    // the editor has an in-progress, unsaved edit when the sync (and its
    // invalidateQueries) lands — the fix must hold the typed value and
    // surface the change instead of silently overwriting it.
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
        HttpResponse.json({ priced: 1, unchanged: 1, attention: [], attention_total: 0 }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    await userEvent.click(screen.getByText('Black'));
    expect(
      await screen.findByRole('spinbutton', { name: /cost/i }, { timeout: 5000 }),
    ).toHaveValue(10);

    // An in-progress, unsaved edit — typed before the sync lands.
    const colorInput = screen.getByRole('textbox', { name: /color label/i });
    await userEvent.clear(colorInput);
    await userEvent.type(colorInput, 'Midnight');
    expect(colorInput).toHaveValue('Midnight');

    // Runs the same invalidateQueries(['filamentPresets']) as the T-006
    // test, but this time the editor is dirty.
    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));
    await screen.findByText(/priced 1/i, {}, { timeout: 5000 });

    // The typed value survives — no silent remount/reset — and a banner
    // explains why the preset now differs from the server.
    const banner = await screen.findByRole('alert', {}, { timeout: 5000 });
    expect(banner).toHaveTextContent(/changed on the server/i);
    expect(colorInput).toHaveValue('Midnight');
    expect(screen.getByRole('spinbutton', { name: /cost/i })).toHaveValue(10);

    await userEvent.click(screen.getByRole('button', { name: /reload from server/i }));

    // Choosing to reload adopts the fresh server copy and dismisses the
    // banner.
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: /cost/i })).toHaveValue(25));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// T-029: legacy rows created before the create/update validator can still
// carry path-shaped or traversal-shaped `filename` values. handleExport must
// flatten those defensively instead of writing them straight into the ZIP.
// These exercise the sanitisation through the real export flow (real JSZip,
// real click handler) rather than reimplementing the sink's internals.
describe('FilamentProfilesPage export ZIP sanitisation', () => {
  async function exportAndReadEntryNames(presetsForTest: FilamentPreset[]): Promise<string[]> {
    server.use(
      http.get('*/filament-profiles', () => HttpResponse.json(presetsForTest)),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
    );

    let capturedBlob: Blob | null = null;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((obj: Blob) => {
      capturedBlob = obj;
      return 'blob:mock-url';
    });
    URL.revokeObjectURL = vi.fn();

    try {
      render(<FilamentProfilesPage />);
      await screen.findByText(presetsForTest[0].color);

      await userEvent.click(screen.getByRole('button', { name: /Export ZIP/i }));
      await waitFor(() => expect(capturedBlob).not.toBeNull());

      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(capturedBlob as unknown as Blob);
      return Object.keys(zip.files).sort();
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  }

  it('flattens legacy traversal/mixed-separator filenames and de-duplicates the resulting collision', async () => {
    const names = await exportAndReadEntryNames([
      preset({ id: 1, name: 'Legacy A', color: 'Red', filename: '../../x.json', content: '{"a":1}' }),
      preset({ id: 2, name: 'Legacy B', color: 'Green', filename: 'a/b\\x.json', content: '{"a":2}' }),
      preset({ id: 3, name: 'Legacy C', color: 'Black', filename: 'bambu_pla_basic_black.json', content: '{"a":3}' }),
    ]);

    // The two legacy traversal/path-shaped filenames both flatten to
    // `x.json`; the second is suffixed instead of clobbering the first,
    // and the already-bare filename is exported byte-identically.
    expect(names).toEqual(['bambu_pla_basic_black.json', 'x-2.json', 'x.json']);
    expect(names.some((n) => n.includes('/') || n.includes('\\') || n.includes('..'))).toBe(false);
  });

  it('falls back to a preset-id name when nothing valid survives stripping', async () => {
    const names = await exportAndReadEntryNames([
      preset({ id: 42, name: 'All Dots', color: 'Purple', filename: '../..', content: '{"a":1}' }),
    ]);

    expect(names).toEqual(['preset-42.json']);
  });

  it('skips a suffix that is already taken by an unrelated bare filename', async () => {
    const names = await exportAndReadEntryNames([
      preset({ id: 1, name: 'Bare', color: 'Orange', filename: 'x-2.json', content: '{"a":1}' }),
      preset({ id: 2, name: 'Legacy A', color: 'Cyan', filename: '../x.json', content: '{"a":2}' }),
      preset({ id: 3, name: 'Legacy B', color: 'Magenta', filename: 'nested/x.json', content: '{"a":3}' }),
    ]);

    // `x-2.json` is already claimed by a bare filename, so the two legacy
    // rows that both flatten to `x.json` land on `x.json` and `x-3.json`
    // instead of clobbering it.
    expect(names).toEqual(['x-2.json', 'x-3.json', 'x.json']);
  });

  it('exports an already-bare filename unchanged', async () => {
    const names = await exportAndReadEntryNames([
      preset({ id: 1, name: 'Bare', color: 'Yellow', filename: 'bambu_pla_basic_black.json', content: '{}' }),
    ]);

    expect(names).toEqual(['bambu_pla_basic_black.json']);
  });

  // User-approved 2026-08-27 widening: the dedup applies to already-bare
  // filenames colliding with each other too (e.g. two rows created via
  // Duplicate), not just to path-shaped filenames that flatten into a
  // collision. Previously jszip's repeated `zip.file()` call silently
  // overwrote the first preset's content; now the second is suffixed and
  // both presets' content survive the export.
  it('de-duplicates two presets sharing the same already-bare filename, preserving both contents', async () => {
    const presetsForTest = [
      preset({ id: 1, name: 'Dup A', color: 'Amber', filename: 'x.json', content: '{"a":1}' }),
      preset({ id: 2, name: 'Dup B', color: 'Beige', filename: 'x.json', content: '{"a":2}' }),
    ];

    server.use(
      http.get('*/filament-profiles', () => HttpResponse.json(presetsForTest)),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
    );

    let capturedBlob: Blob | null = null;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((obj: Blob) => {
      capturedBlob = obj;
      return 'blob:mock-url';
    });
    URL.revokeObjectURL = vi.fn();

    try {
      render(<FilamentProfilesPage />);
      await screen.findByText(presetsForTest[0].color);

      await userEvent.click(screen.getByRole('button', { name: /Export ZIP/i }));
      await waitFor(() => expect(capturedBlob).not.toBeNull());

      const { default: JSZip } = await import('jszip');
      const zip = await JSZip.loadAsync(capturedBlob as unknown as Blob);
      const names = Object.keys(zip.files).sort();

      expect(names).toEqual(['x-2.json', 'x.json']);
      await expect(zip.files['x.json'].async('string')).resolves.toBe('{"a":1}');
      await expect(zip.files['x-2.json'].async('string')).resolves.toBe('{"a":2}');
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});

describe('FilamentProfilesPage upload-fallback import', () => {
  /** Stub an empty server-side scan (the remote-deploy case). */
  function stubEmptyScan() {
    server.use(http.get('*/filament-profiles/bambu-scan', () => HttpResponse.json({ files: [] })));
  }

  function jsonFile(filename: string, body: Record<string, unknown>): File {
    return new File([JSON.stringify(body)], filename, { type: 'application/json' });
  }

  it('opens the file picker when the server scan finds nothing, instead of the "all imported" toast', async () => {
    stubBase();
    stubEmptyScan();
    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-import-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(screen.queryByText(/all already imported/i)).not.toBeInTheDocument();
  });

  it('imports uploaded .json files sequentially, skipping filenames that already exist', async () => {
    stubBase();
    stubEmptyScan();
    const createCalls: string[] = [];
    server.use(
      http.post('*/filament-profiles', async ({ request }) => {
        const body = (await request.json()) as { filename: string };
        createCalls.push(body.filename);
        return HttpResponse.json(preset({ id: 200 + createCalls.length, filename: body.filename }));
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-import-file-input') as HTMLInputElement;
    await userEvent.upload(input, [
      // Duplicate of a loaded preset's filename — must be skipped.
      jsonFile('bambu_pla_basic_black.json', { name: 'Dup' }),
      jsonFile('uploaded_new.json', {
        name: 'Uploaded New',
        filament_vendor: ['Generic'],
        filament_type: ['PLA'],
        filament_colour: ['#123456'],
      }),
    ]);

    await waitFor(() => expect(createCalls).toEqual(['uploaded_new.json']));
    expect(await screen.findByText(/Imported 1 preset/i)).toBeInTheDocument();
  });

  it('unpacks an uploaded export ZIP and imports its JSON entries', async () => {
    stubBase();
    stubEmptyScan();
    const createCalls: string[] = [];
    server.use(
      http.post('*/filament-profiles', async ({ request }) => {
        const body = (await request.json()) as { filename: string };
        createCalls.push(body.filename);
        return HttpResponse.json(preset({ id: 300 + createCalls.length, filename: body.filename }));
      }),
    );

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('zipped_one.json', JSON.stringify({ name: 'Zipped One', filament_vendor: ['Generic'], filament_type: ['PLA'] }));
    zip.file('zipped_two.json', JSON.stringify({ name: 'Zipped Two', filament_vendor: ['Generic'], filament_type: ['PETG'] }));
    zip.file('notes.txt', 'not a preset');
    const blob = await zip.generateAsync({ type: 'blob' });
    const zipFile = new File([blob], 'bambuddy-presets.zip', { type: 'application/zip' });

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-import-file-input') as HTMLInputElement;
    await userEvent.upload(input, zipFile);

    await waitFor(() => expect(createCalls.sort()).toEqual(['zipped_one.json', 'zipped_two.json']));
    expect(await screen.findByText(/Imported 2 preset/i)).toBeInTheDocument();
  });
});

describe('FilamentProfilesPage sync-base upload fallback', () => {
  it('opens the base file picker when sync-base reports an empty bundle (total 0)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/sync-base', () =>
        HttpResponse.json({ added: 0, updated: 0, unchanged: 0, total: 0 }),
      ),
    );
    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-base-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await userEvent.click(screen.getByRole('button', { name: /Sync base/i }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    // The result modal must NOT open for the empty case.
    expect(screen.queryByText(/Base profiles synced/i)).not.toBeInTheDocument();
  });

  it('uploads picked base preset files to base-upload and shows the result modal', async () => {
    stubBase();
    let uploaded: { filename: string; content: string }[] = [];
    server.use(
      http.post('*/filament-profiles/base-upload', async ({ request }) => {
        const body = (await request.json()) as { files: { filename: string; content: string }[] };
        uploaded = body.files;
        return HttpResponse.json({ added: 2, updated: 0, unchanged: 0, total: 2 });
      }),
    );
    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-base-file-input') as HTMLInputElement;
    await userEvent.upload(input, [
      new File(['{"name": "Base PLA"}'], 'base_pla.json', { type: 'application/json' }),
      new File(['{"name": "Base PETG"}'], 'base_petg.json', { type: 'application/json' }),
    ]);

    await waitFor(() =>
      expect(uploaded.map((f) => f.filename).sort()).toEqual(['base_petg.json', 'base_pla.json']),
    );
    expect(await screen.findByText(/Base profiles synced/i)).toBeInTheDocument();
  });
});
