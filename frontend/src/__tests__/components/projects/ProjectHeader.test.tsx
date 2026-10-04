import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { ProjectHeader } from '../../../components/projects/ProjectHeader';
import type { Project } from '../../../api/client';

const project = {
  id: 5,
  code: 'P-0005',
  name: 'Support caméra',
  description: 'Pour drone',
  status: 'active',
  tag_list: [{ id: 1, name: 'drone' }],
  parent_id: 2,
  parent_name: 'Ancien parent',
} as unknown as Project;

let patched: Record<string, unknown> | null;

beforeEach(() => {
  patched = null;
  server.use(
    http.get('/api/v1/projects/tags', () => HttpResponse.json([{ id: 1, name: 'drone', project_count: 1 }])),
    http.patch('/api/v1/projects/5', async ({ request }) => {
      patched = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...project, ...patched });
    }),
    // Only titles change, so blurring the untouched description on the way to
    // the tag field leaves it as typed.
    http.post('/api/v1/projects/ai/reformulate', async ({ request }) => {
      const body = (await request.json()) as { text: string; field: string };
      const text = body.field === 'title' ? `${body.text} (reformulé)` : body.text;
      return HttpResponse.json({ text, model: 'm' });
    }),
  );
});

describe('ProjectHeader', () => {
  it('shows code chip, title, description and tags, but no parent', () => {
    render(<ProjectHeader project={project} />);
    expect(screen.getByText('P-0005')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Support caméra' })).toBeInTheDocument();
    expect(screen.getByText('Pour drone')).toBeInTheDocument();
    expect(screen.getByText('drone')).toBeInTheDocument();
    expect(screen.queryByText('Ancien parent')).not.toBeInTheDocument();
  });

  it('edits title with AI rewording and saves tags as ids + new names', async () => {
    render(<ProjectHeader project={project} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit title, description and tags' }));
    const titleField = screen.getByRole('textbox', { name: 'Title' });
    await userEvent.clear(titleField);
    await userEvent.type(titleField, 'support cam');
    await userEvent.tab();
    await waitFor(() => expect(titleField).toHaveValue('support cam (reformulé)'));
    await userEvent.type(screen.getByRole('combobox'), 'fixation{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(patched).toEqual({
        name: 'support cam (reformulé)',
        description: 'Pour drone',
        tag_ids: [1],
        new_tag_names: ['fixation'],
      }),
    );
  });
});
