/**
 * handleSave's secret-omission invariant — "only send fields that changed /
 * are non-empty" (ZohoSettings.tsx, handleSave) — is what keeps an
 * already-saved client secret / refresh token from being wiped out by a
 * save that only touched an unrelated field. ZohoSettingsProbe.test.tsx
 * covers the probe/unprobed cache-key split but never types into a field or
 * clicks Save, so none of handleSave's branches (or the Test button's
 * failure path) are exercised. These tests fill that gap.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { ZohoSettings } from '../../components/ZohoSettings';
import { server } from '../mocks/server';

// The labels are plain siblings of their `<input>` (no `for`/`id` or
// wrapping), so testing-library's label-association queries can't find
// them. Walk from the label text node to the input in its own wrapper div
// instead — mirrors how a sighted user visually associates them.
function inputForLabel(labelText: string): HTMLInputElement {
  const label = screen.getByText(labelText);
  const input = label.parentElement?.querySelector('input');
  if (!input) throw new Error(`no input found next to label "${labelText}"`);
  return input as HTMLInputElement;
}

describe('ZohoSettings — save payload and test-connection failure', () => {
  let putBodies: Record<string, unknown>[];

  beforeEach(() => {
    putBodies = [];
    server.use(
      // Unprobed status query fired on mount — every test renders the
      // component, so this must always be handled.
      http.get('/api/v1/zoho/status', ({ request }) => {
        const probe = new URL(request.url).searchParams.get('probe');
        return HttpResponse.json({
          configured: probe === 'true',
          reachable: probe === 'true' ? true : null,
          default_contact_id: '',
          default_contact_name: '',
        });
      }),
      http.put('/api/v1/settings/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        putBodies.push(body);
        return HttpResponse.json(body);
      }),
    );
  });

  it('sends only the changed field, omitting untouched blank secret fields', async () => {
    const user = userEvent.setup();
    render(<ZohoSettings />);

    const saveButton = await screen.findByRole('button', { name: /^save$/i });
    await user.type(inputForLabel('Client ID'), 'my-client-id');
    await user.click(saveButton);

    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(putBodies[0]).toMatchObject({ zoho_client_id: 'my-client-id' });
    expect(putBodies[0]).not.toHaveProperty('zoho_client_secret');
    expect(putBodies[0]).not.toHaveProperty('zoho_refresh_token');
  });

  it('includes zoho_client_secret when the secret field is filled in', async () => {
    const user = userEvent.setup();
    render(<ZohoSettings />);

    const saveButton = await screen.findByRole('button', { name: /^save$/i });
    await user.type(inputForLabel('Client Secret'), 'shh-its-a-secret');
    await user.click(saveButton);

    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(putBodies[0]).toMatchObject({ zoho_client_secret: 'shh-its-a-secret' });
  });

  it('sends no PUT request at all when nothing changed', async () => {
    const user = userEvent.setup();
    render(<ZohoSettings />);

    // Let the initial settings query settle before clicking Save, so the
    // form's fields are prefilled and genuinely unchanged.
    const saveButton = await screen.findByRole('button', { name: /^save$/i });
    await user.click(saveButton);

    // The success toast still fires (the short-circuit path), which is a
    // reliable signal handleSave actually ran before we assert on the
    // absence of a network call.
    expect(await screen.findByText('Zoho settings saved')).toBeInTheDocument();
    expect(putBodies).toHaveLength(0);
  });

  it('shows an error toast when the test-connection probe fails', async () => {
    server.use(
      http.get('/api/v1/zoho/status', ({ request }) => {
        const probe = new URL(request.url).searchParams.get('probe');
        if (probe === 'true') {
          return HttpResponse.json({ detail: 'Zoho probe failed' }, { status: 500 });
        }
        return HttpResponse.json({
          configured: false,
          reachable: null,
          default_contact_id: '',
          default_contact_name: '',
        });
      }),
    );

    const user = userEvent.setup();
    render(<ZohoSettings />);

    const testButton = await screen.findByRole('button', { name: /test/i });
    await user.click(testButton);

    expect(await screen.findByText('Zoho probe failed')).toBeInTheDocument();
  });
});
