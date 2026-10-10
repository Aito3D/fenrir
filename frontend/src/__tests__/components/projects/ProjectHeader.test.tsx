import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { ProjectHeader } from '../../../components/projects/ProjectHeader';
import type { Project } from '../../../api/client';
import i18n from '../../../i18n';
import en from '../../../i18n/locales/en';
import fr from '../../../i18n/locales/fr';

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
let reformulated: string[];

beforeEach(() => {
  patched = null;
  reformulated = [];
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
      reformulated.push(`${body.field}:${body.text}`);
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

  it('stays in edit mode with an error toast when saving fails', async () => {
    server.use(http.patch('/api/v1/projects/5', () => HttpResponse.json({ detail: 'boom' }, { status: 500 })));
    render(<ProjectHeader project={project} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit title, description and tags' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save the project')).toBeInTheDocument();
    expect(screen.queryByText('Project saved')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toBeInTheDocument();
  });

  it('cancel leaves edit mode without saving', async () => {
    render(<ProjectHeader project={project} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit title, description and tags' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Support caméra' })).toBeInTheDocument();
    expect(patched).toBeNull();
  });

  it('does not send untouched stored text for rewording, but does send an edit', async () => {
    render(<ProjectHeader project={project} />);
    await userEvent.click(screen.getByRole('button', { name: 'Edit title, description and tags' }));
    const titleField = screen.getByRole('textbox', { name: 'Title' });
    const descField = screen.getByRole('textbox', { name: 'Description' });
    await userEvent.click(titleField);
    await userEvent.click(descField);
    await userEvent.tab();
    expect(reformulated).toEqual([]);
    await userEvent.type(titleField, ' 2');
    await userEvent.tab();
    await waitFor(() => expect(reformulated).toEqual(['title:Support caméra 2']));
  });
});

describe('ProjectHeader in French', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('labels the edit button, title field and save button with the fr projectsPdm strings', async () => {
    await i18n.changeLanguage('fr');
    // Meaningful only while the two locales differ.
    expect(fr.projectsPdm.editHeader).not.toBe(en.projectsPdm.editHeader);
    expect(fr.projectsPdm.titleLabel).not.toBe(en.projectsPdm.titleLabel);
    render(<ProjectHeader project={project} />);
    await userEvent.click(screen.getByRole('button', { name: fr.projectsPdm.editHeader }));
    expect(screen.getByRole('textbox', { name: fr.projectsPdm.titleLabel })).toHaveValue('Support caméra');
    expect(screen.getByRole('button', { name: fr.projectsPdm.save })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: en.projectsPdm.titleLabel })).not.toBeInTheDocument();
  });
});
