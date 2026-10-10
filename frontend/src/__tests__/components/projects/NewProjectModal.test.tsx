import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { useLocation } from 'react-router-dom';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { NewProjectModal } from '../../../components/projects/NewProjectModal';
import en from '../../../i18n/locales/en';

function LocationProbe() {
  return <div data-testid="path">{useLocation().pathname}</div>;
}

let posted: Record<string, unknown>[];
let reformulated: string[];

beforeEach(() => {
  window.history.pushState({}, '', '/');
  posted = [];
  reformulated = [];
  server.use(
    http.get('/api/v1/projects/tags', () => HttpResponse.json([])),
    http.post('/api/v1/projects/', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posted.push(body);
      return HttpResponse.json({ id: 42, code: 'P-0042', name: body.name, status: 'active' }, { status: 201 });
    }),
    // Identity rewording: the tests only watch which field was sent.
    http.post('/api/v1/projects/ai/reformulate', async ({ request }) => {
      const body = (await request.json()) as { text: string; field: string };
      reformulated.push(`${body.field}:${body.text}`);
      return HttpResponse.json({ text: body.text, model: 'm' });
    }),
  );
});

describe('NewProjectModal', () => {
  it('posts the trimmed title and tags, omits a blank description, and navigates to the new project', async () => {
    const onClose = vi.fn();
    render(
      <>
        <NewProjectModal onClose={onClose} />
        <LocationProbe />
      </>,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), '  Support caméra  ');
    await userEvent.type(screen.getByRole('combobox'), 'fixation{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/projects/42'));
    expect(posted).toEqual([{ name: 'Support caméra', tag_ids: [], new_tag_names: ['fixation'] }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('sends a trimmed description when one is typed', async () => {
    render(<NewProjectModal onClose={() => {}} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Pièce');
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), ' pour drone ');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ name: 'Pièce', description: 'pour drone' });
  });

  it('calls onCreated with the new project instead of navigating', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <>
        <NewProjectModal onClose={onClose} onCreated={onCreated} />
        <LocationProbe />
      </>,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Pièce');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0]).toMatchObject({ id: 42, name: 'Pièce' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  it('shows the save-failed toast and stays open when the POST fails', async () => {
    server.use(http.post('/api/v1/projects/', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    const onClose = vi.fn();
    render(
      <>
        <NewProjectModal onClose={onClose} />
        <LocationProbe />
      </>,
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Pièce');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText(en.projectsPdm.saveFailed)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  it('does not post with a blank title', async () => {
    render(<NewProjectModal onClose={() => {}} />);
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), '   {Enter}');
    expect(create).toBeDisabled();
    expect(posted).toEqual([]);
  });

  it('rewords the title and the description through the matching reformulate field on blur', async () => {
    render(<NewProjectModal onClose={() => {}} />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'support cam');
    await userEvent.tab();
    await waitFor(() => expect(reformulated).toEqual(['title:support cam']));
    await userEvent.type(screen.getByRole('textbox', { name: 'Description' }), 'pour drone');
    await userEvent.tab();
    await waitFor(() => expect(reformulated).toEqual(['title:support cam', 'description:pour drone']));
  });
});
