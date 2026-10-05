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

  it('says AI is unavailable when OpenRouter is not configured', async () => {
    server.use(http.post('/api/v1/projects/ai/suggest-tags', () => HttpResponse.json({ detail: 'x' }, { status: 409 })));
    render(<ProjectTagEditor value={[]} onChange={vi.fn()} title="Support" description="" />);
    await userEvent.click(screen.getByRole('button', { name: 'Suggest tags' }));
    expect(await screen.findByText('AI unavailable')).toBeInTheDocument();
  });
});
