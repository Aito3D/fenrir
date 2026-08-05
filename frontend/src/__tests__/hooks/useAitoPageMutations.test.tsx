/**
 * ALSO FIX 7: `SHIPPING_PHONE_RE` in useAitoPageMutations.ts mirrors
 * `_SHIPPING_PHONE_RE` in backend/app/api/routes/aito.py, bound only by a
 * comment on each side. This reads the backend's actual source at test time
 * — rather than hardcoding a second copy of the pattern here, which would
 * only ever catch a divergence the test author remembered to update — so a
 * future edit to either side that is not mirrored on the other fails loudly.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SHIPPING_PHONE_RE, useAitoPageMutations } from '../../hooks/useAitoPageMutations';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { ToastProvider } from '../../contexts/ToastContext';
import { placeholderProject } from '../../utils/aitoOptimistic';
import { api } from '../../api/client';
import type { AitoProject, ZohoQuotePreview, ZohoQuoteShipping } from '../../api/client';

const here = dirname(fileURLToPath(import.meta.url));

describe('SHIPPING_PHONE_RE', () => {
  it('matches _SHIPPING_PHONE_RE in backend/app/api/routes/aito.py exactly', () => {
    const backendSource = readFileSync(
      resolve(here, '../../../../backend/app/api/routes/aito.py'),
      'utf-8',
    );
    const match = backendSource.match(/_SHIPPING_PHONE_RE\s*=\s*re\.compile\(r"([^"]+)"\)/);
    expect(match, 'backend _SHIPPING_PHONE_RE definition not found — did it move or get renamed?').not.toBeNull();
    expect(SHIPPING_PHONE_RE.source).toBe(match![1]);
  });
});

// `importableShipping` is module-private, so it is exercised the same way the
// page exercises it: through the import mutation's POST body. What the page
// tests cover through the full drawer UI (empty LAST name, malformed phone),
// this covers at the hook boundary for the remaining gates.
describe('importMutation — importableShipping gate', () => {
  beforeEach(() => __resetBoardSync());

  function makePreview(shipping: ZohoQuoteShipping | null): ZohoQuotePreview {
    return {
      quote: {
        id: 'e9',
        number: 'DEV26-9001',
        date: '2026-07-29',
        status: 'draft',
        total: 1200,
        currency_code: 'XPF',
        url: 'https://books.zoho.com/estimates/e9',
        salesperson: null,
      },
      client: { id: 'z1', name: 'Import Client', phone: null, email: null, is_company: null },
      suggested_description: 'Support de caméra',
      tasks: [],
      skipped_lines: [],
      shipping,
      existing_project_id: null,
    };
  }

  /** Runs one import through the real hook against a seeded board cache and
   *  returns the POST body `createAitoProject` actually received. */
  async function importBody(shipping: ZohoQuoteShipping | null): Promise<Record<string, unknown>> {
    const spy = vi.spyOn(api, 'createAitoProject').mockResolvedValue({ id: 99 } as AitoProject);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(['aito-projects'], []);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useAitoPageMutations(), { wrapper });

    const preview = makePreview(shipping);
    const placeholder = placeholderProject({
      description: preview.suggested_description,
      client_id: preview.client.id,
      client_name: preview.client.name,
      client_phone: preview.client.phone,
      client_email: preview.client.email,
      client_is_company: preview.client.is_company,
      quote_status: preview.quote.status,
      tasks: preview.tasks,
    });
    act(() => {
      result.current.importMutation.mutate({ description: preview.suggested_description, preview, placeholder });
    });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    return spy.mock.calls[0][0] as Record<string, unknown>;
  }

  const validShipping: ZohoQuoteShipping = {
    island: 'rangiroa',
    service: 'tuamotu',
    first_name: 'Jean-Pierre',
    last_name: 'DUPONT',
    phone: '+689-87123456',
    price: 3200,
  };

  it('drops the whole shipment from the POST body when the first name is empty', async () => {
    // The FIRST-name gate — the page tests only ever blank the last name.
    // Forwarding this shipment would 422 the entire, otherwise-fine import.
    const body = await importBody({ ...validShipping, first_name: '' });
    expect(body).not.toHaveProperty('shipping_island');
    expect(body).not.toHaveProperty('shipping_first_name');
    expect(body).not.toHaveProperty('shipping_last_name');
    expect(body).not.toHaveProperty('shipping_phone');
    expect(body).not.toHaveProperty('shipping_price');
  });

  it('drops the shipment when the phone is missing entirely', async () => {
    const body = await importBody({ ...validShipping, phone: '' });
    expect(body).not.toHaveProperty('shipping_island');
    expect(body).not.toHaveProperty('shipping_phone');
  });

  it('forwards a fully-valid shipment, prefixed and without service', async () => {
    const body = await importBody(validShipping);
    expect(body).toMatchObject({
      shipping_island: 'rangiroa',
      shipping_first_name: 'Jean-Pierre',
      shipping_last_name: 'DUPONT',
      shipping_phone: '+689-87123456',
      shipping_price: 3200,
    });
    expect(body).not.toHaveProperty('shipping_service');
  });
});
