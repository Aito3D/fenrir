import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { TaskStepFields } from '../../components/aito/TaskStepFields';
import { emptyTaskDraft } from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

function ControlledTaskStepFields({ initial }: { initial: TaskDraft }) {
  const [task, setTask] = useState(initial);
  return <TaskStepFields task={task} onChange={setTask} />;
}

/** Uppercases whatever it is sent, so a corrected field is unmistakable. */
function mockShoutingProofreader() {
  const calls: string[] = [];
  server.use(
    http.post('/api/v1/aito/proofread', async ({ request }) => {
      const body = (await request.json()) as { text: string };
      calls.push(body.text);
      return HttpResponse.json({ text: body.text.toUpperCase(), model: 'test' });
    }),
  );
  return calls;
}

/** Every field a quote quotes back at the client is spell-checked on blur —
 *  the title and all four service descriptions. Same component in the create
 *  drawer and in the detail panel's expanded card, so this covers both. */
describe('TaskStepFields AI proofreading', () => {
  it('corrects the task title when focus leaves it', async () => {
    const user = userEvent.setup();
    mockShoutingProofreader();
    render(<ControlledTaskStepFields initial={emptyTaskDraft()} />);

    const title = screen.getByLabelText('Optional title');
    await user.type(title, 'capot');
    await user.tab();

    await waitFor(() => expect(title).toHaveValue('CAPOT'));
  });

  it.each([
    ['Scan', 'scanCost'],
    ['Modeling', 'modelisationCost'],
    ['Machining', 'usinageCost'],
  ] as const)('corrects the %s description when focus leaves it', async (label, costKey) => {
    const user = userEvent.setup();
    mockShoutingProofreader();
    render(<ControlledTaskStepFields initial={{ ...emptyTaskDraft(), [costKey]: 1200 }} />);

    const description = screen.getByLabelText(new RegExp(`${label}.*[Dd]escription`));
    await user.type(description, 'pièce à corriger');
    await user.tab();

    await waitFor(() => expect(description).toHaveValue('PIÈCE À CORRIGER'));
  });

  it('corrects the printing note when focus leaves it', async () => {
    const user = userEvent.setup();
    mockShoutingProofreader();
    render(
      <ControlledTaskStepFields
        initial={{ ...emptyTaskDraft(), impressionCost: 500, impressionDescription: 'note' }}
      />,
    );

    const note = screen.getByLabelText(/Printing.*[Dd]escription/);
    await user.clear(note);
    await user.type(note, 'support à imprimer');
    await user.tab();

    await waitFor(() => expect(note).toHaveValue('SUPPORT À IMPRIMER'));
  });

  it('marks the title and every description as an AI field', () => {
    render(
      <TaskStepFields
        task={{ ...emptyTaskDraft(), scanCost: 1200, usinageCost: 50 }}
        onChange={() => {}}
      />,
    );
    // Title + scan + machining descriptions.
    expect(screen.getAllByTestId('ai-field-marker')).toHaveLength(3);
  });
});
