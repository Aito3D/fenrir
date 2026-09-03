/**
 * Tests for TwoFactorSettings — the TOTP enable/disable/backup-codes flows.
 *
 * Coverage:
 * - Enabling TOTP: QR code + secret are shown (secret masked until revealed),
 *   entering a valid 6-digit code calls POST /auth/2fa/totp/enable with that
 *   exact code, and the returned backup codes are displayed.
 * - Entering a wrong code on the confirm step shows the "invalid code" toast
 *   and leaves the confirm form open (not silently swallowed).
 * - Disabling TOTP with a valid code calls POST /auth/2fa/totp/disable with
 *   that code, shows the success toast, and the view reverts to the
 *   "not enabled" state after the status refetch.
 * - Regenerating backup codes calls POST /auth/2fa/totp/regenerate-backup-codes
 *   with the entered code and displays the newly returned codes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { TwoFactorSettings } from '../../components/TwoFactorSettings';

interface StatusState {
  totp_enabled: boolean;
  email_otp_enabled: boolean;
  backup_codes_remaining: number;
}

function renderComponent() {
  return render(<TwoFactorSettings />);
}

describe('TwoFactorSettings', () => {
  let status: StatusState;
  let enableBody: Record<string, unknown> | null;
  let disableBody: Record<string, unknown> | null;
  let regenBody: Record<string, unknown> | null;

  beforeEach(() => {
    status = { totp_enabled: false, email_otp_enabled: false, backup_codes_remaining: 0 };
    enableBody = null;
    disableBody = null;
    regenBody = null;

    server.use(
      http.get('/api/v1/auth/2fa/status', () => HttpResponse.json(status)),
      http.get('/api/v1/auth/oidc/links', () => HttpResponse.json([])),

      http.post('/api/v1/auth/2fa/totp/setup', () =>
        HttpResponse.json({
          secret: 'JBSWY3DPEHPK3PXP',
          qr_code_b64: 'ZmFrZVFSY29kZQ==',
          issuer: 'Bambuddy',
        }),
      ),

      http.post('/api/v1/auth/2fa/totp/enable', async ({ request }) => {
        enableBody = (await request.json()) as Record<string, unknown>;
        if (enableBody.code !== '123456') {
          return HttpResponse.json({ detail: 'Invalid code' }, { status: 400 });
        }
        status.totp_enabled = true;
        status.backup_codes_remaining = 10;
        return HttpResponse.json({
          message: 'enabled',
          backup_codes: ['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444'],
        });
      }),

      http.post('/api/v1/auth/2fa/totp/disable', async ({ request }) => {
        disableBody = (await request.json()) as Record<string, unknown>;
        if (disableBody.code !== '654321') {
          return HttpResponse.json({ detail: 'Invalid code' }, { status: 400 });
        }
        status.totp_enabled = false;
        status.backup_codes_remaining = 0;
        return HttpResponse.json({ message: 'disabled' });
      }),

      http.post('/api/v1/auth/2fa/totp/regenerate-backup-codes', async ({ request }) => {
        regenBody = (await request.json()) as Record<string, unknown>;
        status.backup_codes_remaining = 10;
        return HttpResponse.json({
          message: 'regenerated',
          backup_codes: ['NEW11111', 'NEW22222', 'NEW33333'],
        });
      }),
    );
  });

  it('enables TOTP: shows the QR code and masked secret, reveals it, verifies the code, and displays the backup codes', async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(
      await screen.findByRole('button', { name: /set up authenticator app/i }, { timeout: 5000 }),
    );

    const qrImg = await screen.findByAltText('TOTP QR Code', {}, { timeout: 5000 });
    expect(qrImg).toHaveAttribute('src', 'data:image/png;base64,ZmFrZVFSY29kZQ==');

    // Secret is masked by default.
    expect(screen.getByText('••••••••••••••••')).toBeInTheDocument();
    expect(screen.queryByText('JBSWY3DPEHPK3PXP')).not.toBeInTheDocument();

    // Reveal it via the eye toggle button next to the masked secret.
    const secretRow = screen.getByText('••••••••••••••••').closest('div');
    expect(secretRow).not.toBeNull();
    const revealBtn = within(secretRow as HTMLElement).getAllByRole('button')[0];
    await user.click(revealBtn);
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.queryByText('••••••••••••••••')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /scanned/i }));

    const codeInput = await screen.findByPlaceholderText('000000', {}, { timeout: 5000 });
    const activateBtn = screen.getByRole('button', { name: /activate/i });
    expect(activateBtn).toBeDisabled();

    await user.type(codeInput, '123456');
    expect(activateBtn).not.toBeDisabled();
    await user.click(activateBtn);

    await waitFor(() => expect(enableBody).toEqual({ code: '123456' }), { timeout: 5000 });

    expect(await screen.findByText('Save your backup codes', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('AAAA1111')).toBeInTheDocument();
    expect(screen.getByText('BBBB2222')).toBeInTheDocument();
    expect(screen.getByText('CCCC3333')).toBeInTheDocument();
    expect(screen.getByText('DDDD4444')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /saved my codes/i }));

    await waitFor(
      () => expect(screen.queryByText('Save your backup codes')).not.toBeInTheDocument(),
      { timeout: 5000 },
    );
    // Status refetched after invalidation — the card now shows the enabled state.
    expect(await screen.findByText(/10 backup codes remaining/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disable authenticator/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set up authenticator app/i })).not.toBeInTheDocument();
  });

  it('shows the "invalid code" toast and keeps the confirm form open when the wrong TOTP code is entered', async () => {
    const user = userEvent.setup();
    renderComponent();

    await user.click(
      await screen.findByRole('button', { name: /set up authenticator app/i }, { timeout: 5000 }),
    );
    await screen.findByAltText('TOTP QR Code', {}, { timeout: 5000 });
    await user.click(screen.getByRole('button', { name: /scanned/i }));

    const codeInput = await screen.findByPlaceholderText('000000', {}, { timeout: 5000 });
    await user.type(codeInput, '000000');
    await user.click(screen.getByRole('button', { name: /activate/i }));

    await waitFor(() => expect(enableBody).toEqual({ code: '000000' }), { timeout: 5000 });
    expect(
      await screen.findByText('Invalid code. Please try again.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Still on the confirm step — did not advance to the backup-codes screen.
    expect(screen.queryByText('Save your backup codes')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
  });

  it('disables TOTP when a valid code is entered', async () => {
    status.totp_enabled = true;
    status.backup_codes_remaining = 5;
    const user = userEvent.setup();
    renderComponent();

    expect(await screen.findByText(/5 backup codes remaining/i, {}, { timeout: 5000 })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /disable authenticator/i }));

    const codeInput = await screen.findByPlaceholderText('000000 or XXXXXXXX', {}, { timeout: 5000 });
    const disableBtn = screen.getByRole('button', { name: /disable authenticator/i });
    expect(disableBtn).toBeDisabled();

    await user.type(codeInput, '654321');
    expect(disableBtn).not.toBeDisabled();
    await user.click(disableBtn);

    await waitFor(() => expect(disableBody).toEqual({ code: '654321' }), { timeout: 5000 });
    expect(
      await screen.findByText('Authenticator app disabled.', {}, { timeout: 5000 }),
    ).toBeInTheDocument();

    // Status refetched — back to the "not enabled" main view.
    expect(
      await screen.findByRole('button', { name: /set up authenticator app/i }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate backup codes/i })).not.toBeInTheDocument();
  });

  it('regenerates backup codes with the entered code and displays the new codes', async () => {
    status.totp_enabled = true;
    status.backup_codes_remaining = 2;
    const user = userEvent.setup();
    renderComponent();

    expect(await screen.findByText(/2 backup codes remaining/i, {}, { timeout: 5000 })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /regenerate backup codes/i }));

    const codeInput = await screen.findByPlaceholderText('000000 or XXXXXXXX', {}, { timeout: 5000 });
    await user.type(codeInput, '111222');
    await user.click(screen.getByRole('button', { name: /regenerate backup codes/i }));

    await waitFor(() => expect(regenBody).toEqual({ code: '111222' }), { timeout: 5000 });

    expect(await screen.findByText('New backup codes', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('NEW11111')).toBeInTheDocument();
    expect(screen.getByText('NEW22222')).toBeInTheDocument();
    expect(screen.getByText('NEW33333')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /saved my codes/i }));

    await waitFor(
      () => expect(screen.queryByText('New backup codes')).not.toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(await screen.findByText(/10 backup codes remaining/i, {}, { timeout: 5000 })).toBeInTheDocument();
  });
});
