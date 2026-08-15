import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { QuoteResultList } from '../../components/aito/QuoteResultList';
import type { ZohoEstimateSummary } from '../../api/client';

const quotes: ZohoEstimateSummary[] = [
  { id: 'e1', number: 'DEV26-2461', customer_name: 'ACME SARL', date: '2026-07-30', total: 45000, currency_code: 'XPF', status: 'accepted' },
  { id: 'e2', number: 'DEV26-2462', customer_name: 'Marie EXEMPLE', date: '2026-07-27', total: 5600, currency_code: 'XPF', status: 'draft' },
];

let searchCalls: string[];

beforeEach(() => {
  searchCalls = [];
  server.use(
    http.get('/api/v1/zoho/estimates', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      searchCalls.push(q);
      return HttpResponse.json(q ? quotes.filter((x) => x.number.includes(q)) : quotes);
    }),
    http.get('/api/v1/zoho/estimates/:id/preview', () => HttpResponse.json({})),
    http.get('/api/v1/aito/', () => HttpResponse.json([])),
  );
});

describe('QuoteResultList', () => {
  it('lists recent quotes before anything is typed', async () => {
    render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(await screen.findByText('DEV26-2461')).toBeInTheDocument();
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    expect(screen.getByText(/recent quotes/i)).toBeInTheDocument();
  });

  it('debounces typing into a single filtered search', async () => {
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await screen.findByText('DEV26-2461');

    await user.type(screen.getByRole('searchbox'), '2462');
    await waitFor(() => expect(screen.queryByText('DEV26-2461')).not.toBeInTheDocument());
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    // One empty-q fetch on mount plus one for the settled term — not one per keystroke.
    expect(searchCalls).toEqual(['', '2462']);
  });

  it('selects with arrow keys + Enter from the search input', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={onSelect} onClear={vi.fn()} />);
    await screen.findByText('DEV26-2461');

    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2' }));
  });

  it('marks a quote the board already imported and BLOCKS selecting it, mouse and keyboard', async () => {
    server.use(
      http.get('/api/v1/aito/', () =>
        // `status: 'active'` here is documentation, not an exercised filter — the
        // real endpoint never returns trashed rows, so the component doesn't
        // filter by status itself. Trashed projects therefore never block:
        // trashing frees the quote (the backend's _reject_duplicate_quote rule).
        HttpResponse.json([{ id: 87, quote_id: 'e1', status: 'active' }]),
      ),
    );
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={onSelect} onClear={vi.fn()} />);

    expect(await screen.findByText(/imported → #87/i)).toBeInTheDocument();

    // Keyboard path first (a mouse click below would move the highlight):
    // Enter on the highlighted blocked row is refused.
    await user.click(screen.getByRole('searchbox'));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).not.toHaveBeenCalled();

    // Mouse path: the row is marked disabled and the click is refused.
    const row = screen.getByRole('option', { name: /DEV26-2461/i });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    await user.click(row);
    expect(onSelect).not.toHaveBeenCalled();

    // The next, unimported quote still selects normally.
    await user.click(screen.getByRole('option', { name: /DEV26-2462/i }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'e2' }));
  });

  it('collapses to the selected card and Change hands control back', async () => {
    const onClear = vi.fn();
    render(<QuoteResultList selected={quotes[0]} onSelect={vi.fn()} onClear={onClear} />);

    expect(screen.getByText(/DEV26-2461/)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /change/i }));
    expect(onClear).toHaveBeenCalled();
  });

  it('prefetches the preview when a row is hovered', async () => {
    let prefetched = 0;
    server.use(
      http.get('/api/v1/zoho/estimates/:id/preview', () => {
        prefetched += 1;
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.hover(await screen.findByText('DEV26-2461'));
    await waitFor(() => expect(prefetched).toBe(1));
  });

  // The dwell gate (T-078): a hover/arrow-key sweep only warms the preview
  // cache for the row the pointer or cursor actually rests on. Fake timers
  // throughout — a wall-clock-dependent test here would just add a ninth
  // flake to the four this repo already carries.
  describe('prefetch dwell gate', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    it('sweeping across rows quickly fires at most one prefetch, for the row rested on', async () => {
      const prefetchedIds: string[] = [];
      server.use(
        http.get('/api/v1/zoho/estimates/:id/preview', ({ params }) => {
          prefetchedIds.push(params.id as string);
          return HttpResponse.json({});
        }),
      );
      render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
      const row1 = await screen.findByRole('option', { name: /DEV26-2461/i });
      const row2 = screen.getByRole('option', { name: /DEV26-2462/i });

      // A pointer sweeping down the list crosses row1 then settles on row2,
      // all faster than the dwell window.
      fireEvent.mouseEnter(row1);
      fireEvent.mouseEnter(row2);

      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(prefetchedIds).toEqual(['e2']);
    });

    it('unmounting with a dwell timer pending fires no prefetch and leaks nothing', async () => {
      let prefetched = 0;
      server.use(
        http.get('/api/v1/zoho/estimates/:id/preview', () => {
          prefetched += 1;
          return HttpResponse.json({});
        }),
      );
      const result = render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
      const row1 = await screen.findByRole('option', { name: /DEV26-2461/i });

      fireEvent.mouseEnter(row1);
      result.unmount();

      // If the timer weren't cleared on unmount, this would either throw
      // (calling prefetch against an unmounted tree's query client) or
      // silently fire the network call it exists to prevent.
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      expect(prefetched).toBe(0);
    });

    it('moves the highlight immediately, before the dwell timer fires', async () => {
      render(<QuoteResultList selected={null} onSelect={vi.fn()} onClear={vi.fn()} />);
      const row1 = await screen.findByRole('option', { name: /DEV26-2461/i });
      const row2 = screen.getByRole('option', { name: /DEV26-2462/i });
      expect(row2).toHaveAttribute('aria-selected', 'false');

      fireEvent.mouseEnter(row2);

      // No time advanced at all: the highlight is synchronous, un-debounced.
      expect(row2).toHaveAttribute('aria-selected', 'true');
      expect(row1).toHaveAttribute('aria-selected', 'false');
    });

    afterEach(() => {
      vi.useRealTimers();
    });
  });
});
