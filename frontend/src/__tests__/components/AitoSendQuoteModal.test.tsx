import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SendQuoteModal } from '../../components/aito/SendQuoteModal';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

const project = {
  id: 12,
  quote_id: 'EST-9',
  quote_number: 'QT-00412',
  client_email: 'contact@example.pf',
} as unknown as AitoProject;

const CONTENT = {
  subject: 'Devis QT-00412',
  body: '<p>Bonjour</p>',
  recipients: [
    { email: 'contact@example.pf', name: 'Jean-Pierre DUPONT', contact_person_id: 'cp-1' },
    { email: 'compta@example.pf', name: 'Marie TAMA', contact_person_id: 'cp-2' },
  ],
  default_email: 'contact@example.pf',
};

describe('SendQuoteModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preselects the default address and sends it', async () => {
    vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue(CONTENT);
    const send = vi
      .spyOn(api, 'sendAitoQuoteEmail')
      .mockResolvedValue({ project, marked_sent: true });
    const user = userEvent.setup();
    render(<SendQuoteModal project={project} onClose={() => {}} />);

    const select = await screen.findByLabelText(/recipient/i);
    await waitFor(() => expect(select).toHaveValue('contact@example.pf'));

    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(12, { to: 'contact@example.pf' }),
    );
  });

  it('shows the plain success toast when the card moved', async () => {
    vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue(CONTENT);
    vi.spyOn(api, 'sendAitoQuoteEmail').mockResolvedValue({ project, marked_sent: true });
    const user = userEvent.setup();
    render(<SendQuoteModal project={project} onClose={() => {}} />);

    await screen.findByLabelText(/recipient/i);
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText('Quote sent to contact@example.pf')).toBeInTheDocument();
    expect(
      screen.queryByText(/could not be moved automatically/i),
    ).not.toBeInTheDocument();
  });

  it('shows the plain success toast — not a warning — for a re-send that needed no move', async () => {
    // marked_sent: null is what the server returns when the card was
    // already past the Quote column (e.g. a re-send from Waiting). That is
    // not a failure, so this must still be the ordinary success toast.
    vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue(CONTENT);
    vi.spyOn(api, 'sendAitoQuoteEmail').mockResolvedValue({ project, marked_sent: null });
    const user = userEvent.setup();
    render(<SendQuoteModal project={project} onClose={() => {}} />);

    await screen.findByLabelText(/recipient/i);
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText('Quote sent to contact@example.pf')).toBeInTheDocument();
    expect(
      screen.queryByText(/could not be moved automatically/i),
    ).not.toBeInTheDocument();
  });

  it('warns, rather than showing plain success, when the card move failed after sending', async () => {
    // marked_sent: false is the genuine-failure case: the email already
    // went out (this is the user-approved T-013 degrade-to-200 behavior,
    // unchanged here) but the card-move half hit a DB error server-side.
    vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue(CONTENT);
    vi.spyOn(api, 'sendAitoQuoteEmail').mockResolvedValue({ project, marked_sent: false });
    const user = userEvent.setup();
    render(<SendQuoteModal project={project} onClose={() => {}} />);

    await screen.findByLabelText(/recipient/i);
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(
      await screen.findByText(
        'Quote sent to contact@example.pf — the card could not be moved automatically. Move it manually.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Quote sent to contact@example.pf')).not.toBeInTheDocument();
  });

  it('sends whichever address the user picks', async () => {
    vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue(CONTENT);
    const send = vi
      .spyOn(api, 'sendAitoQuoteEmail')
      .mockResolvedValue({ project, marked_sent: true });
    const user = userEvent.setup();
    render(<SendQuoteModal project={project} onClose={() => {}} />);

    await user.selectOptions(await screen.findByLabelText(/recipient/i), 'compta@example.pf');
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(12, { to: 'compta@example.pf' }));
  });

  it('disables Send when the client has no address at all', async () => {
    vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue({
      ...CONTENT,
      recipients: [],
      default_email: null,
    });
    render(<SendQuoteModal project={project} onClose={() => {}} />);

    expect(await screen.findByText(/no email address/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  it('shows the failure and keeps the modal open when the prefill fails', async () => {
    vi.spyOn(api, 'getAitoQuoteEmail').mockRejectedValue(new Error('502'));
    const onClose = vi.fn();
    render(<SendQuoteModal project={project} onClose={onClose} />);

    expect(await screen.findByText(/could not load the email details/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the body in a locked-down frame, never in the page', async () => {
    // The body is Books' HTML. It is upstream content on a template we do
    // not control, so it must never become live markup in the app document.
    const hostile =
      '<img src=x onerror="window.__pwned = true">' +
      '<script>window.__pwned = true</script>Bonjour';

    vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue({ ...CONTENT, body: hostile });
    const { container } = render(<SendQuoteModal project={project} onClose={() => {}} />);

    await screen.findByLabelText(/recipient/i);

    // Nothing from the body reached the app document itself...
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();

    // ...and what did reach the frame is sanitised and sandboxed.
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    const srcdoc = frame.getAttribute('srcdoc') || '';
    expect(srcdoc).not.toContain('<script');
    expect(srcdoc).not.toContain('onerror');
    expect(srcdoc).toContain('Bonjour');
  });
});
