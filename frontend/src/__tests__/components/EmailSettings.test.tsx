/**
 * Tests for EmailSettings — the SMTP configuration panel.
 *
 * Covers handleSave's required-field and auth-conditional validation
 * (blocking the save call rather than merely showing a toast),
 * handleTest's empty-recipient guard, and handleToggleAdvancedAuth's
 * "authentication must be enabled first" refusal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { EmailSettings } from '../../components/EmailSettings';
import { server } from '../mocks/server';

describe('EmailSettings', () => {
  let saveBodies: Record<string, unknown>[];
  let testBodies: Record<string, unknown>[];
  let enableCalls: number;

  beforeEach(() => {
    saveBodies = [];
    testBodies = [];
    enableCalls = 0;

    server.use(
      // No SMTP settings saved yet — the component keeps its blank defaults.
      http.get('/api/v1/auth/smtp', () => HttpResponse.json(null)),
      http.post('/api/v1/auth/smtp', async ({ request }) => {
        saveBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ message: 'saved' });
      }),
      http.post('/api/v1/auth/smtp/test', async ({ request }) => {
        testBodies.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ success: true, message: 'Test email sent' });
      }),
      http.get('/api/v1/auth/advanced-auth/status', () =>
        HttpResponse.json({
          advanced_auth_enabled: false,
          smtp_configured: false,
          local_login_enabled: true,
          autologin_provider_id: null,
        }),
      ),
      http.post('/api/v1/auth/advanced-auth/enable', () => {
        enableCalls += 1;
        return HttpResponse.json({ message: 'enabled', advanced_auth_enabled: true });
      }),
      // Auth disabled by default (matches the default handler, made
      // explicit here since the "refuses when disabled" test depends on it).
      http.get('*/api/v1/auth/status', () =>
        HttpResponse.json({ auth_enabled: false, requires_setup: false }),
      ),
    );
  });

  it('shows a required-fields toast and does not save when the host and from-email are blank', async () => {
    const user = userEvent.setup();
    render(<EmailSettings />);

    const saveButton = await screen.findByRole('button', { name: 'Save Settings' });
    await user.click(saveButton);

    expect(await screen.findByText('Please fill in all required fields')).toBeInTheDocument();
    expect(saveBodies).toHaveLength(0);
  });

  it('shows a username-required toast when authentication is enabled and the username is blank', async () => {
    const user = userEvent.setup();
    render(<EmailSettings />);

    await user.type(await screen.findByPlaceholderText('smtp.gmail.com'), 'smtp.example.com');
    await user.type(screen.getByPlaceholderText('your@email.com'), 'sender@example.com');
    // Authentication is enabled by default and the username field is left blank.

    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(
      await screen.findByText('Username is required when authentication is enabled'),
    ).toBeInTheDocument();
    expect(saveBodies).toHaveLength(0);
  });

  it('calls saveSMTPSettings with the form payload on a valid submit', async () => {
    const user = userEvent.setup();
    render(<EmailSettings />);

    await user.type(await screen.findByPlaceholderText('smtp.gmail.com'), 'smtp.example.com');
    await user.type(screen.getByPlaceholderText('your.email@gmail.com'), 'sender@example.com');
    await user.type(screen.getByPlaceholderText('App password'), 'hunter2');
    await user.type(screen.getByPlaceholderText('your@email.com'), 'sender@example.com');

    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => expect(saveBodies).toHaveLength(1));
    expect(saveBodies[0]).toEqual({
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_username: 'sender@example.com',
      smtp_password: 'hunter2',
      smtp_security: 'starttls',
      smtp_auth_enabled: true,
      smtp_from_email: 'sender@example.com',
      smtp_from_name: 'Fenrir',
    });
    expect(await screen.findByText('SMTP settings saved successfully')).toBeInTheDocument();
  });

  it('requires a non-empty test email before calling testSMTP', async () => {
    const user = userEvent.setup();
    render(<EmailSettings />);

    const sendButton = await screen.findByRole('button', { name: 'Send Test Email' });
    await user.click(sendButton);

    expect(await screen.findByText('Please enter a test email address')).toBeInTheDocument();
    expect(testBodies).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('test@example.com'), 'qa@example.com');
    await user.click(sendButton);

    await waitFor(() => expect(testBodies).toHaveLength(1));
    expect(testBodies[0]).toEqual({ test_recipient: 'qa@example.com' });
  });

  it('refuses to toggle advanced authentication when global authentication is disabled', async () => {
    const user = userEvent.setup();
    render(<EmailSettings />);

    const enableButton = await screen.findByRole('button', { name: 'Enable' });
    await user.click(enableButton);

    expect(
      await screen.findByText('Please enable authentication first to use email-based features.'),
    ).toBeInTheDocument();
    expect(enableCalls).toBe(0);
  });
});
