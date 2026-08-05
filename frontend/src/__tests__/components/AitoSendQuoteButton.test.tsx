import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SendQuoteButton } from '../../components/aito/SendQuoteButton';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

const project = { id: 12, quote_id: 'EST-9', client_email: 'contact@example.pf' } as unknown as AitoProject;

describe('SendQuoteButton', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing for a project with no quote', () => {
    render(<SendQuoteButton project={{ ...project, quote_id: null } as unknown as AitoProject} />);
    // Not toBeEmptyDOMElement(): the `render` wrapper's ToastProvider always
    // mounts a toast-viewport div in-tree (not a portal), so `container` is
    // never empty regardless of this component's own output. Same pattern as
    // QuotePrintButton's identical "no quote" test.
    expect(screen.queryByRole('button', { name: /send quote/i })).not.toBeInTheDocument();
  });

  it('opens the modal and fetches the prefill for this project', async () => {
    const spy = vi.spyOn(api, 'getAitoQuoteEmail').mockResolvedValue({
      subject: 'Devis QT-00412',
      body: '<p>Bonjour</p>',
      recipients: [{ email: 'contact@example.pf', name: 'Jean-Pierre DUPONT', contact_person_id: 'cp-1' }],
      default_email: 'contact@example.pf',
    });
    const user = userEvent.setup();
    render(<SendQuoteButton project={project} />);

    await user.click(screen.getByRole('button', { name: /send quote/i }));

    expect(await screen.findByLabelText(/recipient/i)).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith(12);
  });
});
