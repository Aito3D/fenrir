import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { HeimdallSettings } from '../../components/HeimdallSettings';
import { server } from '../mocks/server';

describe('HeimdallSettings', () => {
  let puts: Record<string, unknown>[];
  let tests: Record<string, unknown>[];

  beforeEach(() => {
    puts = [];
    tests = [];
    server.use(
      http.get('/api/v1/settings/', () =>
        HttpResponse.json({ heimdall_base_url: 'http://pos.local:8081', heimdall_api_token: '', aito_deposit_pct: 0, aito_quote_validity_days: 15 }),
      ),
      http.put('/api/v1/settings/', async ({ request }) => {
        puts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({});
      }),
      http.post('/api/v1/heimdall/test', async ({ request }) => {
        tests.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ configured: true, reachable: false, error: 'forbidden' });
      }),
    );
  });

  it('prefills the URL and numbers, never the token, and omits an untouched token on save', async () => {
    render(<HeimdallSettings />);
    const url = (await screen.findByLabelText('Heimdall URL')) as HTMLInputElement;
    expect(url.value).toBe('http://pos.local:8081');
    expect((screen.getByLabelText('API token') as HTMLInputElement).value).toBe('');
    await userEvent.clear(screen.getByLabelText('Deposit (%)'));
    await userEvent.type(screen.getByLabelText('Deposit (%)'), '30');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ heimdall_base_url: 'http://pos.local:8081', aito_deposit_pct: 30, aito_quote_validity_days: 15 });
    expect(puts[0]).not.toHaveProperty('heimdall_api_token');
  });

  it('sends a typed token on save and to the test button', async () => {
    render(<HeimdallSettings />);
    await screen.findByLabelText('Heimdall URL');
    await userEvent.type(screen.getByLabelText('API token'), 'hmd_live.84f32b71ac095ed2.secret');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(tests).toHaveLength(1));
    expect(tests[0]).toEqual({ base_url: 'http://pos.local:8081', token: 'hmd_live.84f32b71ac095ed2.secret' });
    expect(await screen.findByText('The key is missing the payments:read or payments:write scope')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts[0]).toMatchObject({ heimdall_api_token: 'hmd_live.84f32b71ac095ed2.secret' }));
  });
});
