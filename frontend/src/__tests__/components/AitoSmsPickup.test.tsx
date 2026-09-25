import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SmsPickupButton } from '../../components/aito/SmsPickupButton';
import { SmsPickupModal } from '../../components/aito/SmsPickupModal';
import { api, ApiError } from '../../api/client';
import type { AitoProject } from '../../api/client';

const project = {
  id: 12,
  column: 'finish',
  client_name: 'ACME',
  client_phone: '87 12 34 56',
  client_contacted_at: null,
  due_date: null,
} as unknown as AitoProject;

const DRAFT = {
  message: 'Ia Ora na, la pièce pour la Renault Clio est disponible à nos bureaux à Arue. Aito3D',
  model: 'mistralai/mistral-small',
};

describe('SmsPickupButton', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is disabled — with the reason in its title — when the client has no phone', () => {
    render(<SmsPickupButton project={{ ...project, client_phone: null } as unknown as AitoProject} />);
    const button = screen.getByRole('button', { name: /pickup sms/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'This client has no phone number');
  });

  it('opens the modal, which generates a draft on mount', async () => {
    const generate = vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    const user = userEvent.setup();
    render(<SmsPickupButton project={project} />);

    await user.click(screen.getByRole('button', { name: /pickup sms/i }));
    expect(await screen.findByDisplayValue(DRAFT.message)).toBeInTheDocument();
    expect(generate).toHaveBeenCalledWith(12);
  });
});

describe('SmsPickupModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the EDITED text, not the generated draft', async () => {
    vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    const send = vi.spyOn(api, 'sendAitoPickupSms').mockResolvedValue({ sent: true });
    const user = userEvent.setup();
    render(<SmsPickupModal project={project} onClose={() => {}} />);

    const textarea = await screen.findByLabelText(/message/i);
    await user.clear(textarea);
    await user.type(textarea, 'Ia Ora na, c’est prêt. Aito3D');
    await user.click(screen.getByRole('button', { name: /send to phone/i }));

    await waitFor(() => expect(send).toHaveBeenCalledWith(12, 'Ia Ora na, c’est prêt. Aito3D'));
    expect(await screen.findByText(/notification sent to your phone/i)).toBeInTheDocument();
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

  // T-030: a failed Send is no longer one outcome. The backend tells a refusal
  // Pushcut gave apart from a transport failure that may already have put the
  // notification on the phone, and from a refused duplicate — and each gets its
  // own toast, because "it failed" and "it may have gone twice" are different
  // things to do next.
  it('a push Pushcut never answered warns that the SMS may already have gone', async () => {
    vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    vi.spyOn(api, 'sendAitoPickupSms').mockRejectedValue(
      new ApiError(
        'Pushcut did not answer in time — the notification may already have been pushed; check the phone before sending again',
        502,
      ),
    );
    const user = userEvent.setup();
    render(<SmsPickupModal project={project} onClose={() => {}} />);

    await screen.findByDisplayValue(DRAFT.message);
    await user.click(screen.getByRole('button', { name: /send to phone/i }));

    expect(await screen.findByText(/the sms may already have gone/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not send the notification/i)).not.toBeInTheDocument();
    // The modal stays open with the text, so the sender can check the phone
    // and decide — not lose what they were about to send.
    expect(screen.getByDisplayValue(DRAFT.message)).toBeInTheDocument();
  });

  it('a refused duplicate says the message already went, not that sending failed', async () => {
    vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    vi.spyOn(api, 'sendAitoPickupSms').mockRejectedValue(
      new ApiError(
        'Already sent — this message went to the phone less than a minute ago; check it before sending again',
        409,
      ),
    );
    const user = userEvent.setup();
    render(<SmsPickupModal project={project} onClose={() => {}} />);

    await screen.findByDisplayValue(DRAFT.message);
    await user.click(screen.getByRole('button', { name: /send to phone/i }));

    expect(await screen.findByText(/already went to the phone/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not send the notification/i)).not.toBeInTheDocument();
  });

  it('another 409 on this route keeps the generic failure toast', async () => {
    // Only the guard's own detail means "already sent" — the route's other
    // 409s (no phone, not finished, Pushcut unconfigured) must not read as it.
    vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    vi.spyOn(api, 'sendAitoPickupSms').mockRejectedValue(new ApiError('Pushcut is not configured', 409));
    const user = userEvent.setup();
    render(<SmsPickupModal project={project} onClose={() => {}} />);

    await screen.findByDisplayValue(DRAFT.message);
    await user.click(screen.getByRole('button', { name: /send to phone/i }));

    expect(await screen.findByText(/could not send the notification/i)).toBeInTheDocument();
    expect(screen.queryByText(/may already have gone/i)).not.toBeInTheDocument();
  });

  it('a Send that fails keeps the modal open with the text intact', async () => {
    vi.spyOn(api, 'generateAitoPickupMessage').mockResolvedValue(DRAFT);
    vi.spyOn(api, 'sendAitoPickupSms').mockRejectedValue(new Error('502'));
    const user = userEvent.setup();
    render(<SmsPickupModal project={project} onClose={() => {}} />);

    await screen.findByDisplayValue(DRAFT.message);
    await user.click(screen.getByRole('button', { name: /send to phone/i }));

    expect(await screen.findByText(/could not send the notification/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue(DRAFT.message)).toBeInTheDocument();
  });
});
