/**
 * ProjectDetailPage: the BOM price fields of the add-part form and the inline
 * edit form. Pins their rendered markup (both sites share one price input) and
 * the price normalisation of a calculation: never negative, two decimals.
 */

/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { ProjectDetailPage } from '../../pages/ProjectDetailPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: '1' }),
    useNavigate: () => vi.fn(),
  };
});

const project = {
  id: 1,
  name: 'Test Project',
  description: null,
  color: '#00ae42',
  status: 'active',
  priority: 'normal',
  due_date: null,
  notes: null,
  parent_id: null,
  budget: null,
  is_template: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const part = {
  id: 7,
  project_id: 1,
  name: 'M3 screws',
  quantity_needed: 4,
  quantity_acquired: 0,
  unit_price: 1.5,
  sourcing_url: null,
  remarks: null,
  is_complete: false,
};

/** The price field's flex row (quantity + price), as rendered. */
function priceRow(input: HTMLElement): string {
  return input.parentElement!.parentElement!.outerHTML;
}

describe('ProjectDetailPage BOM price inputs', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/projects/:id/tree', () => HttpResponse.json({ project_id: 1, code: null, sections: [] })),
      http.get('/api/v1/projects/:id', () => HttpResponse.json(project)),
      http.get('/api/v1/projects/:id/archives', () => HttpResponse.json([])),
      http.get('/api/v1/projects/:id/bom', () => HttpResponse.json([part])),
      http.get('/api/v1/projects/:id/timeline', () => HttpResponse.json([])),
      http.get('/api/v1/library/folders/by-project/:id', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', () => HttpResponse.json([]))
    );
  });

  it('renders the add-part price field and normalises a calculation', async () => {
    const user = userEvent.setup();
    render(<ProjectDetailPage />);

    await user.click(await screen.findByRole('button', { name: /Add Part/ }));
    const price = screen.getByPlaceholderText(/^Price \(/);
    expect(priceRow(price)).toMatchInlineSnapshot(`"<div class="flex gap-2"><input class="w-20 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-bambu-green" placeholder="Qty" min="1" type="number" value="1"><div class="relative flex-1 min-w-0"><input placeholder="Price ($)" inputmode="decimal" autocomplete="off" class="w-full bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded px-3 py-2 text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green " style="padding-left: 2rem;" type="text" value=""><button type="button" tabindex="-1" aria-label="Calculator keyboard (+ − × ÷)" aria-pressed="false" title="Calculator keyboard (+ − × ÷)" class="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded transition-colors disabled:opacity-40 text-bambu-gray hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calculator w-3.5 h-3.5" aria-hidden="true"><rect width="16" height="20" x="4" y="2" rx="2"></rect><line x1="8" x2="16" y1="6" y2="6"></line><line x1="16" x2="16" y1="14" y2="18"></line><path d="M16 10h.01"></path><path d="M12 10h.01"></path><path d="M8 10h.01"></path><path d="M12 14h.01"></path><path d="M8 14h.01"></path><path d="M12 18h.01"></path><path d="M8 18h.01"></path></svg></button></div></div>"`);

    await user.type(price, '10/3');
    await user.tab();
    await waitFor(() => expect(price).toHaveValue('3.33'));
    await user.clear(price);
    await user.type(price, '1-5');
    await user.tab();
    await waitFor(() => expect(price).toHaveValue('0'));
  });

  it('renders the edit-part price field and normalises a calculation', async () => {
    const user = userEvent.setup();
    render(<ProjectDetailPage />);

    await user.click(await screen.findByTitle('Edit', { selector: 'button' }));
    const price = screen.getByPlaceholderText(/^Price \(/);
    expect(price).toHaveValue('1.5');
    expect(priceRow(price)).toMatchInlineSnapshot(`"<div class="flex gap-2"><input class="w-20 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-bambu-green" placeholder="Qty" min="1" type="number" value="4"><div class="relative flex-1 min-w-0"><input placeholder="Price ($)" inputmode="decimal" autocomplete="off" class="w-full bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded px-3 py-2 text-sm text-white placeholder-bambu-gray focus:outline-none focus:border-bambu-green " style="padding-left: 2rem;" type="text" value="1.5"><button type="button" tabindex="-1" aria-label="Calculator keyboard (+ − × ÷)" aria-pressed="false" title="Calculator keyboard (+ − × ÷)" class="absolute left-1 top-1/2 -translate-y-1/2 p-1 rounded transition-colors disabled:opacity-40 text-bambu-gray hover:text-white"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-calculator w-3.5 h-3.5" aria-hidden="true"><rect width="16" height="20" x="4" y="2" rx="2"></rect><line x1="8" x2="16" y1="6" y2="6"></line><line x1="16" x2="16" y1="14" y2="18"></line><path d="M16 10h.01"></path><path d="M12 10h.01"></path><path d="M8 10h.01"></path><path d="M12 14h.01"></path><path d="M8 14h.01"></path><path d="M12 18h.01"></path><path d="M8 18h.01"></path></svg></button></div></div>"`);

    await user.clear(price);
    await user.type(price, '2*1.005');
    await user.tab();
    await waitFor(() => expect(price).toHaveValue('2.01'));
  });
});
