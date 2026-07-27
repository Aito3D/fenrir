import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { NewProjectModal } from '../../components/aito/NewProjectModal';

const DEFAULT_ID = '66407000001237340';

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: true, reachable: true,
        default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage',
      }),
    ),
    http.get('/api/v1/zoho/contacts', () => HttpResponse.json([])),
  );
});

describe('NewProjectModal', () => {
  it('opens with the default client preselected and submits it', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');
    await user.click(screen.getByRole('button', { name: /create project/i }));
    expect(onCreate).toHaveBeenCalledWith(
      'Support de caméra',
      expect.objectContaining({ id: DEFAULT_ID, isDefault: true }),
    );
  });

  it('blocks submit on a malformed email and reveals the error', async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={onCreate} />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /client/i })).toHaveValue('Client de passage'),
    );
    await user.type(screen.getByLabelText(/product description/i), 'Support de caméra');
    await user.type(screen.getByLabelText(/^email/i), 'nope');
    // Never blurred, so no message yet — but the button is already disabled.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create project/i })).toBeDisabled();

    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(onCreate).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/^email/i));
    await user.click(screen.getByRole('button', { name: /create project/i }));
    expect(onCreate).toHaveBeenCalled();
  });

  it('switches to the create-client sub-step and back', async () => {
    const user = userEvent.setup();
    render(<NewProjectModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const combobox = await screen.findByRole('combobox', { name: /client/i });
    await user.clear(combobox);
    await user.type(combobox, 'zzz');
    await user.click(await screen.findByRole('button', { name: /create new client/i }));
    expect(screen.getByLabelText(/company name/i)).toHaveValue('zzz');
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByLabelText(/product description/i)).toBeInTheDocument();
  });
});
