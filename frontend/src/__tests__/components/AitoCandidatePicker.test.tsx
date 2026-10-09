import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { CandidatePicker } from '../../components/aito/CandidatePicker';
import { makeProject } from '../fixtures/aitoProject';

const project = makeProject({ id: 41, description: 'Pièce carrosserie' });
const board = [
  project,
  makeProject({ id: 33, description: 'Tambour inox', client_name: 'PACIFIC MARINE' }),
  makeProject({ id: 17, description: 'Engrenage' }),
];

describe('CandidatePicker', () => {
  it('names the radiogroup, filters by the controlled query and reports picks', async () => {
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json(board)));
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onQueryChange = vi.fn();
    render(
      <CandidatePicker
        project={project}
        selectedId={17}
        query="eng"
        onQueryChange={onQueryChange}
        onSelect={onSelect}
        ariaLabel="Pick a card"
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Pick a card' })).toBeInTheDocument();
    const search = screen.getByRole('searchbox');
    expect(search).toHaveValue('eng');
    const rows = await screen.findAllByTestId('merge-candidate');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('aria-checked', 'true');

    // Controlled: typing reports the next value but the box keeps the prop.
    await user.type(search, 'x');
    expect(onQueryChange).toHaveBeenLastCalledWith('engx');
    expect(search).toHaveValue('eng');

    await user.click(rows[0]);
    expect(onSelect).toHaveBeenCalledWith(17);
  });
});
