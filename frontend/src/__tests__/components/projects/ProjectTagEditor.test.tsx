import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { ProjectTagEditor, splitTagDrafts } from '../../../components/projects/ProjectTagEditor';

beforeEach(() => {
  server.use(
    http.get('/api/v1/projects/tags', () => HttpResponse.json([{ id: 1, name: 'drone', project_count: 3 }])),
    http.post('/api/v1/projects/ai/suggest-tags', () =>
      HttpResponse.json({ suggestions: [{ name: 'drone', tag_id: 1 }, { name: 'fixation', tag_id: null }], model: 'm' }),
    ),
  );
});

describe('splitTagDrafts', () => {
  it('separates existing ids from new names', () => {
    expect(splitTagDrafts([{ id: 1, name: 'a' }, { id: null, name: 'b' }])).toEqual({ tag_ids: [1], new_tag_names: ['b'] });
  });
});

describe('ProjectTagEditor', () => {
  it('picks an existing tag by typing and Enter', async () => {
    const onChange = vi.fn();
    render(<ProjectTagEditor value={[]} onChange={onChange} title="t" description="" />);
    await userEvent.type(screen.getByRole('combobox'), 'DRO{Enter}');
    expect(onChange).toHaveBeenCalledWith([{ id: 1, name: 'drone' }]);
  });

  it('creates a new tag draft when nothing matches', async () => {
    const onChange = vi.fn();
    render(<ProjectTagEditor value={[]} onChange={onChange} title="t" description="" />);
    await userEvent.type(screen.getByRole('combobox'), 'pièce auto{Enter}');
    expect(onChange).toHaveBeenCalledWith([{ id: null, name: 'pièce auto' }]);
  });

  it('shows AI suggestions as chips and applies only the one accepted', async () => {
    const onChange = vi.fn();
    render(<ProjectTagEditor value={[]} onChange={onChange} title="Support drone" description="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Suggest tags' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Add fixation' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([{ id: null, name: 'fixation' }]);
  });

  it('sends trimmed text and existing tag ids, and hides suggestions already applied', async () => {
    let body: Record<string, unknown> | null = null;
    server.use(
      http.post('/api/v1/projects/ai/suggest-tags', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ suggestions: [{ name: 'drone', tag_id: 1 }, { name: 'fixation', tag_id: null }], model: 'm' });
      }),
    );
    render(
      <ProjectTagEditor
        value={[{ id: 1, name: 'drone' }, { id: null, name: 'brouillon' }]}
        onChange={vi.fn()}
        title="  Support drone  "
        description="  Pour FPV  "
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Suggest tags' }));
    expect(await screen.findByRole('button', { name: 'Add fixation' })).toBeInTheDocument();
    expect(body).toEqual({ title: 'Support drone', description: 'Pour FPV', exclude_tag_ids: [1] });
    expect(screen.queryByRole('button', { name: 'Add drone' })).not.toBeInTheDocument();
  });

  it('removes a tag through its chip', async () => {
    const onChange = vi.fn();
    render(
      <ProjectTagEditor value={[{ id: 1, name: 'drone' }, { id: null, name: 'fixation' }]} onChange={onChange} title="t" description="" />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove drone' }));
    expect(onChange).toHaveBeenCalledWith([{ id: null, name: 'fixation' }]);
  });

  it('ignores Enter on blank or comma-only text and never adds a tag twice', async () => {
    const onChange = vi.fn();
    render(<ProjectTagEditor value={[{ id: null, name: 'Fixation' }]} onChange={onChange} title="t" description="" />);
    const box = screen.getByRole('combobox');
    await userEvent.type(box, '   {Enter}');
    await userEvent.clear(box);
    await userEvent.type(box, ', ,{Enter}');
    await userEvent.clear(box);
    await userEvent.type(box, 'FIXATION{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('says AI is unavailable when OpenRouter is not configured', async () => {
    server.use(http.post('/api/v1/projects/ai/suggest-tags', () => HttpResponse.json({ detail: 'x' }, { status: 409 })));
    render(<ProjectTagEditor value={[]} onChange={vi.fn()} title="Support" description="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Suggest tags' }));
    expect(await screen.findByText('AI unavailable')).toBeInTheDocument();
  });

  it('says AI is unavailable on a 502 and leaves the tags unchanged', async () => {
    server.use(http.post('/api/v1/projects/ai/suggest-tags', () => HttpResponse.json({ detail: 'bad gateway' }, { status: 502 })));
    const onChange = vi.fn();
    render(<ProjectTagEditor value={[{ id: 1, name: 'drone' }]} onChange={onChange} title="Support" description="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Suggest tags' }));
    expect(await screen.findByText('AI unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No suggestions')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says there are no suggestions when the AI returns an empty list', async () => {
    server.use(http.post('/api/v1/projects/ai/suggest-tags', () => HttpResponse.json({ suggestions: [], model: 'm' })));
    const onChange = vi.fn();
    render(<ProjectTagEditor value={[]} onChange={onChange} title="Support" description="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Suggest tags' }));
    expect(await screen.findByText('No suggestions')).toBeInTheDocument();
    expect(screen.queryByText('AI unavailable')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
