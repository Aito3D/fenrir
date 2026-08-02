/**
 * AiSettings save path — mirrors ZohoSettingsProbe.test.tsx's render harness.
 * Covers the two write-only-secret rules from the task-14 brief:
 *   - the API key is never prefilled from GET (server always returns "")
 *   - an untouched (empty) key field is OMITTED from the PUT payload, so
 *     saving the model alone never wipes an already-stored key
 * and the model default: an emptied model field falls back to
 * 'mistralai/mistral-small' rather than being saved as ''.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../../contexts/AuthContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { FullscreenProvider } from '../../contexts/FullscreenContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { AiSettings } from '../../components/AiSettings';
import { server } from '../mocks/server';

function renderWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = rtlRender(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ThemeProvider>
            <FullscreenProvider>
              <ToastProvider>
                <AiSettings />
              </ToastProvider>
            </FullscreenProvider>
          </ThemeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

describe('AiSettings — save path', () => {
  let putBodies: Record<string, unknown>[];

  beforeEach(() => {
    putBodies = [];
    server.use(
      http.get('/api/v1/settings/', () => {
        return HttpResponse.json({
          // Write-only secret — the server never echoes a stored key back.
          openrouter_api_key: '',
          openrouter_model: 'anthropic/claude-3-haiku',
        });
      }),
      http.put('/api/v1/settings/', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        putBodies.push(body);
        return HttpResponse.json(body);
      }),
    );
  });

  it('prefills the model from GET but leaves the API key field blank', async () => {
    renderWithClient();

    const modelInput = await screen.findByDisplayValue('anthropic/claude-3-haiku');
    expect(modelInput).toBeInTheDocument();

    const apiKeyInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(apiKeyInput).toBeInTheDocument();
    expect(apiKeyInput.value).toBe('');
  });

  it('omits the API key from the PUT payload when the field is left untouched', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByDisplayValue('anthropic/claude-3-haiku');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(putBodies[0]).not.toHaveProperty('openrouter_api_key');
    expect(putBodies[0].openrouter_model).toBe('anthropic/claude-3-haiku');
  });

  it('sends a trimmed API key when the field is filled in', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByDisplayValue('anthropic/claude-3-haiku');
    const apiKeyInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    await user.type(apiKeyInput, '  sk-or-test-key  ');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(putBodies[0].openrouter_api_key).toBe('sk-or-test-key');
  });

  it('falls back to the mistral-small default when the model field is cleared', async () => {
    const user = userEvent.setup();
    renderWithClient();

    const modelInput = await screen.findByDisplayValue('anthropic/claude-3-haiku');
    await user.clear(modelInput);
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(putBodies.length).toBe(1));
    expect(putBodies[0].openrouter_model).toBe('mistralai/mistral-small');
    expect(putBodies[0]).not.toHaveProperty('openrouter_api_key');
  });
});
