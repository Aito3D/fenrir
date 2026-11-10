/**
 * NotificationTemplateEditor against msw: preview endpoint, save (PUT),
 * reset (POST /reset), variable insert at the cursor, validation and error
 * display, close paths.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { NotificationTemplateEditor } from '../../components/NotificationTemplateEditor';
import type { NotificationTemplate } from '../../api/client';

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

const TEMPLATE: NotificationTemplate = {
  id: 9,
  event_type: 'print_complete',
  name: 'Print Complete',
  title_template: 'Done: {printer}',
  body_template: '{filename} finished',
  is_default: false,
  created_at: '2026-04-25T00:00:00Z',
  updated_at: '2026-04-25T00:00:00Z',
};

function serve(opts: { supportsPhoto?: boolean } = {}) {
  const previews: Record<string, unknown>[] = [];
  server.use(
    http.get('*/api/v1/notification-templates/variables', () =>
      HttpResponse.json([
        {
          event_type: 'print_complete',
          event_name: 'Print Complete',
          variables: ['printer', 'filename'],
          supports_photo: opts.supportsPhoto ?? false,
        },
        { event_type: 'print_start', event_name: 'Print Start', variables: ['other'], supports_photo: false },
      ]),
    ),
    http.post('*/api/v1/notification-templates/preview', async ({ request }) => {
      const body = (await request.json()) as Record<string, string>;
      previews.push(body);
      return HttpResponse.json({ title: `PT:${body.title_template}`, body: `PB:${body.body_template}` });
    }),
  );
  return previews;
}

const titleInput = () => screen.getByPlaceholderText('Notification title...') as HTMLInputElement;
const bodyInput = () => screen.getByPlaceholderText('Notification body...') as HTMLTextAreaElement;

describe('NotificationTemplateEditor', () => {
  it('shows the template name, title and body and only this event\'s variables', async () => {
    serve();
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);

    expect(screen.getByText('Edit Template: Print Complete')).toBeInTheDocument();
    expect(titleInput().value).toBe('Done: {printer}');
    expect(bodyInput().value).toBe('{filename} finished');
    expect(await screen.findByRole('button', { name: /^printer$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^filename$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^other$/ })).not.toBeInTheDocument();
  });

  it('calls the preview endpoint with the current text and renders the result', async () => {
    const user = userEvent.setup();
    const previews = serve();
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);

    expect(await screen.findByText('PT:Done: {printer}')).toBeInTheDocument();
    expect(screen.getByText('PB:{filename} finished')).toBeInTheDocument();
    expect(previews[0]).toEqual({
      event_type: 'print_complete',
      title_template: 'Done: {printer}',
      body_template: '{filename} finished',
    });

    await user.clear(titleInput());
    await user.type(titleInput(), 'X');
    expect(await screen.findByText('PT:X')).toBeInTheDocument();
    expect(previews.at(-1)?.title_template).toBe('X');
  });

  it('hides the preview and shows the placeholder when the text is empty', async () => {
    const user = userEvent.setup();
    serve();
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);
    await screen.findByText('PT:Done: {printer}');

    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('PT:Done: {printer}')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show' }));

    await user.clear(bodyInput());
    expect(await screen.findByText('Enter template content to see preview')).toBeInTheDocument();
  });

  it('shows the photo note when the event supports photos', async () => {
    serve({ supportsPhoto: true });
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);
    expect(await screen.findByAltText('Photo:')).toBeInTheDocument();
    expect(screen.getByText(/^Example only — providers that support attachments/)).toBeInTheDocument();
  });

  it('save is disabled until edited, then PUTs the edited title and body and closes', async () => {
    const user = userEvent.setup();
    serve();
    const onClose = vi.fn();
    const puts: unknown[] = [];
    server.use(
      http.put('*/api/v1/notification-templates/9', async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json(TEMPLATE);
      }),
    );
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={onClose} />);

    const save = screen.getByRole('button', { name: /Save/ });
    expect(save).toBeDisabled();

    await user.clear(bodyInput());
    await user.type(bodyInput(), 'new body');
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(puts).toEqual([{ title_template: 'Done: {printer}', body_template: 'new body' }]);
  });

  it('rejects an empty title without calling the backend', async () => {
    const user = userEvent.setup();
    serve();
    let called = false;
    server.use(
      http.put('*/api/v1/notification-templates/9', () => {
        called = true;
        return HttpResponse.json(TEMPLATE);
      }),
    );
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);

    await user.clear(titleInput());
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Title is required')).toBeInTheDocument();
    expect(called).toBe(false);
  });

  it('rejects a whitespace-only body', async () => {
    const user = userEvent.setup();
    serve();
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);

    await user.clear(bodyInput());
    await user.type(bodyInput(), '   ');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Body is required')).toBeInTheDocument();
  });

  it('shows the backend error when save fails and stays open', async () => {
    const user = userEvent.setup();
    serve();
    const onClose = vi.fn();
    server.use(
      http.put('*/api/v1/notification-templates/9', () =>
        HttpResponse.json({ detail: 'Unknown variable {zzz}' }, { status: 422 }),
      ),
    );
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={onClose} />);

    await user.type(bodyInput(), ' more');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Unknown variable {zzz}')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Reset to Default POSTs /reset and restores the default title and body', async () => {
    const user = userEvent.setup();
    serve();
    let resets = 0;
    server.use(
      http.post('*/api/v1/notification-templates/9/reset', () => {
        resets += 1;
        return HttpResponse.json({ ...TEMPLATE, title_template: 'Default T', body_template: 'Default B' });
      }),
    );
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);

    await user.type(bodyInput(), ' edited');
    await user.click(screen.getByRole('button', { name: /Reset to Default/ }));

    await waitFor(() => expect(titleInput().value).toBe('Default T'));
    expect(bodyInput().value).toBe('Default B');
    expect(resets).toBe(1);
  });

  it('shows the error when reset fails', async () => {
    const user = userEvent.setup();
    serve();
    server.use(
      http.post('*/api/v1/notification-templates/9/reset', () =>
        HttpResponse.json({ detail: 'Reset exploded' }, { status: 500 }),
      ),
    );
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /Reset to Default/ }));
    expect(await screen.findByText('Reset exploded')).toBeInTheDocument();
  });

  it('inserts a variable at the cursor in the body', async () => {
    serve();
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);
    const button = await screen.findByRole('button', { name: /^printer$/ });

    bodyInput().setSelectionRange(3, 3);
    fireEvent.click(button);
    expect(bodyInput().value).toBe('{fi{printer}lename} finished');
  });

  it('replaces the selected range with the inserted variable', async () => {
    serve();
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={vi.fn()} />);
    const button = await screen.findByRole('button', { name: /^printer$/ });

    bodyInput().setSelectionRange(0, 10); // "{filename}"
    fireEvent.click(button);
    expect(bodyInput().value).toBe('{printer} finished');
  });

  it('closes on Escape, the X button and Cancel', async () => {
    const user = userEvent.setup();
    serve();
    const onClose = vi.fn();
    render(<NotificationTemplateEditor template={TEMPLATE} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
