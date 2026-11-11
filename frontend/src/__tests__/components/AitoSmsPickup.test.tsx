import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SmsPickupButton, SMS_PICKUP_ENABLED } from '../../components/aito/SmsPickupButton';
import { SmsPickupModal } from '../../components/aito/SmsPickupModal';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { api, ApiError, setAuthToken } from '../../api/client';
import type { AitoProject } from '../../api/client';

const project = {
  id: 12,
  column: 'finish',
  client_name: 'ACME',
  client_phone: '87 12 34 56',
  client_contacted_at: null,
  done_at: null,
  due_date: null,
} as unknown as AitoProject;

const DRAFT = {
  message: 'Ia Ora na, la pièce pour la Renault Clio est disponible à nos bureaux à Arue. Aito3D',
  model: 'mistralai/mistral-small',
};

describe('SmsPickupButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAuthToken(null);
  });

  it('is hidden from a non-admin, who the backend would refuse anyway', async () => {
    setAuthToken('test-token', 'session');
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ id: 2, username: 'operator', is_admin: false, permissions: ['aito:read', 'aito:update'] }),
      ),
    );
    const meLoaded = new Promise<void>((resolve) => server.events.on('response:mocked', ({ request }) => {
      if (request.url.includes('/auth/me')) resolve();
    }));
    render(<SmsPickupButton project={project} />);
    await meLoaded;
    await waitFor(() => expect(screen.queryByRole('button', { name: /pickup sms/i })).not.toBeInTheDocument());
  });

  it('is disabled — with the reason in its title — when the client has no phone', () => {
    render(<SmsPickupButton project={{ ...project, client_phone: null } as unknown as AitoProject} />);
    const button = screen.getByRole('button', { name: /pickup sms/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'This client has no phone number');
  });

  it.runIf(!SMS_PICKUP_ENABLED)('is disabled for every card while the kill switch is off', () => {
    render(<SmsPickupButton project={project} />);
    expect(screen.getByRole('button', { name: /pickup sms/i })).toBeDisabled();
  });

  it.runIf(SMS_PICKUP_ENABLED)('opens the modal, which generates a draft on mount', async () => {
    const generate = vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    const user = userEvent.setup();
    render(<SmsPickupButton project={project} />);

    await user.click(screen.getByRole('button', { name: /pickup sms/i }));
    expect(await screen.findByDisplayValue(DRAFT.message)).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith(12);
  });
});

const RELAY = 'http://localhost:8765/send';

/** Stands in for scripts/sms_relay_mac.py; records what the page posted. */
function relayAnswers(response: () => Response) {
  const posted: unknown[] = [];
  server.use(
    http.post(RELAY, async ({ request }) => {
      posted.push(await request.json());
      return response();
    }),
  );
  return posted;
}

async function openAndSend() {
  vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
  const user = userEvent.setup();
  render(<SmsPickupModal project={project} onClose={() => {}} />);
  await screen.findByDisplayValue(DRAFT.message);
  await user.click(screen.getByRole('button', { name: /send sms/i }));
}

describe('SmsPickupModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the EDITED text through the local relay, then records it', async () => {
    vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    const posted = relayAnswers(() => new HttpResponse('sent'));
    const record = vi.spyOn(api, 'recordAitoPickupSms').mockResolvedValue({ sent: true });
    const user = userEvent.setup();
    render(<SmsPickupModal project={project} onClose={() => {}} />);

    const textarea = await screen.findByLabelText(/message/i);
    await user.clear(textarea);
    await user.type(textarea, 'Ia Ora na, c’est prêt. Aito3D');
    await user.click(screen.getByRole('button', { name: /send sms/i }));

    expect(await screen.findByText('SMS sent')).toBeInTheDocument();
    expect(posted).toEqual([{ phone: '87 12 34 56', text: 'Ia Ora na, c’est prêt. Aito3D' }]);
    expect(record).toHaveBeenCalledWith(12);
  });

  it('a failed record after a real send still reports the SMS as sent', async () => {
    // A retry would text the client twice; only the timeline entry is lost.
    relayAnswers(() => new HttpResponse('sent'));
    vi.spyOn(api, 'recordAitoPickupSms').mockRejectedValue(new ApiError('boom', 500));
    await openAndSend();
    expect(await screen.findByText('SMS sent')).toBeInTheDocument();
  });

  it('regenerate asks for a fresh draft and replaces the text', async () => {
    const generate = vi
      .spyOn(api, 'generateAitoPickupMessage')
      .mockResolvedValueOnce(DRAFT)
      .mockResolvedValueOnce({ ...DRAFT, message: 'Ia Ora na, deuxième version. Aito3D' });
    const user = userEvent.setup();
    render(<SmsPickupModal project={project} onClose={() => {}} />);

    await screen.findByDisplayValue(DRAFT.message);
    await user.click(screen.getByRole('button', { name: /regenerate/i }));

    expect(await screen.findByDisplayValue('Ia Ora na, deuxième version. Aito3D')).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('shows the recipient so a wrong number is caught before the phone', async () => {
    vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    render(<SmsPickupModal project={project} onClose={() => {}} />);
    expect(await screen.findByText(/ACME · 87 12 34 56/)).toBeInTheDocument();
  });

  it('surfaces a failed generation instead of an empty textarea', async () => {
    vi.spyOn(api, 'generateAitoPickupMessage').mockRejectedValue(new Error('502'));
    render(<SmsPickupModal project={project} onClose={() => {}} />);
    expect(await screen.findByText(/could not draft the message/i)).toBeInTheDocument();
  });

  it('no relay on this machine says so, records nothing, and keeps the text', async () => {
    relayAnswers(() => HttpResponse.error());
    const record = vi.spyOn(api, 'recordAitoPickupSms');
    await openAndSend();
    expect(await screen.findByText(/sms relay not reachable/i)).toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(DRAFT.message)).toBeInTheDocument();
  });

  it('a Messages timeout warns that the SMS may already have gone', async () => {
    relayAnswers(() => new HttpResponse('Messages did not answer', { status: 504 }));
    const record = vi.spyOn(api, 'recordAitoPickupSms');
    await openAndSend();
    expect(await screen.findByText(/the sms may already have gone/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not send the sms/i)).not.toBeInTheDocument();
    // No event may claim a send nobody confirmed.
    expect(record).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(DRAFT.message)).toBeInTheDocument();
  });

  it('a refusal from Messages keeps the generic failure toast and the text', async () => {
    relayAnswers(() => new HttpResponse('Messages refused: no SMS account', { status: 502 }));
    const record = vi.spyOn(api, 'recordAitoPickupSms');
    await openAndSend();
    expect(await screen.findByText(/could not send the sms/i)).toBeInTheDocument();
    expect(screen.queryByText(/may already have gone/i)).not.toBeInTheDocument();
    expect(record).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(DRAFT.message)).toBeInTheDocument();
  });
});
