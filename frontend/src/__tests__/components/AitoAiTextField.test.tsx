import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AITO_AI_SETTLE_MS, AiTextField } from '../../components/aito/AiTextField';

/** Feeds `onChange` back into state: the field is controlled, and the AI's
 *  correction arrives as an `onChange` the parent must apply for the swap to
 *  be visible. */
function ControlledAiTextField({
  initial = '',
  multiline = false,
  onChangeSpy,
}: {
  initial?: string;
  multiline?: boolean;
  onChangeSpy?: (next: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AiTextField
      label="Task title"
      value={value}
      multiline={multiline}
      onChange={(next) => {
        onChangeSpy?.(next);
        setValue(next);
      }}
    />
  );
}

/** POST /aito/proofread returning `text`, counting the calls it received. */
function mockProofread(text: string) {
  const calls: string[] = [];
  server.use(
    http.post('/api/v1/aito/proofread', async ({ request }) => {
      const body = (await request.json()) as { text: string };
      calls.push(body.text);
      return HttpResponse.json({ text, model: 'mistralai/mistral-small-2603' });
    }),
  );
  return calls;
}

describe('AiTextField', () => {
  it('corrects the text when focus leaves the field', async () => {
    const user = userEvent.setup();
    mockProofread('Capot avec 3 pièces');
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot avec 3 pieces');
    await user.tab();

    await waitFor(() => expect(field).toHaveValue('Capot avec 3 pièces'));
  });

  it('sends the typed text, not the corrected one, and only once per edit', async () => {
    // The correction lands through onChange, which re-renders the field: without
    // a latch, that blur-then-settle cycle would keep paying for the same text.
    const user = userEvent.setup();
    const calls = mockProofread('Capot');
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot');
    await user.tab();

    await waitFor(() => expect(field).toHaveValue('Capot'));
    // Re-focusing and leaving without typing must not spend another call.
    await user.click(field);
    await user.tab();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['capot']);
  });

  it('restores the user’s own wording through the undo control', async () => {
    const user = userEvent.setup();
    mockProofread('Capot avant');
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot avan');
    await user.tab();
    await waitFor(() => expect(field).toHaveValue('Capot avant'));

    await user.click(screen.getByRole('button', { name: /restore my text/i }));
    expect(field).toHaveValue('capot avan');
    // One undo, one restore: the control goes away once used.
    expect(screen.queryByRole('button', { name: /restore my text/i })).not.toBeInTheDocument();
  });

  it('never re-corrects text the user restored', async () => {
    const user = userEvent.setup();
    const calls = mockProofread('Capot');
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot');
    await user.tab();
    await waitFor(() => expect(field).toHaveValue('Capot'));
    await user.click(screen.getByRole('button', { name: /restore my text/i }));

    await user.click(field);
    await user.tab();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(['capot']);
    expect(field).toHaveValue('capot');
  });

  it('spends nothing on an empty field', async () => {
    const user = userEvent.setup();
    const calls = mockProofread('anything');
    render(<ControlledAiTextField initial="   " />);

    await user.click(screen.getByLabelText('Task title'));
    await user.tab();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it('keeps the user’s text when the AI is unavailable', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/v1/aito/proofread', () => HttpResponse.json({ detail: 'no key' }, { status: 409 })));
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot');
    await user.tab();

    await new Promise((r) => setTimeout(r, 30));
    expect(field).toHaveValue('capot');
    expect(screen.queryByRole('button', { name: /restore my text/i })).not.toBeInTheDocument();
  });

  it('glows while the correction is in flight and settles once it lands', async () => {
    // The sparkle alone is 12px of signal for a wait that can run a second or
    // two — the field itself has to say it is busy, and has to stop saying it.
    // The class lands on the WRAPPER: the travelling arcs are a masked
    // pseudo-element ring, and a replaced element (input/textarea) has none.
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/aito/proofread', async () => {
        await gate;
        return HttpResponse.json({ text: 'Capot', model: 'm' });
      }),
    );
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot');
    await user.tab();

    await waitFor(() => expect(field.parentElement).toHaveClass('animate-ai-thinking'));
    release();
    await waitFor(() => expect(field).toHaveValue('Capot'));
    expect(field.parentElement).not.toHaveClass('animate-ai-thinking');
  });

  it('keeps the ring travelling and fades it out after the correction lands', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/v1/aito/proofread', () => HttpResponse.json({ text: 'Capot', model: 'm' })));
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot');
    await user.tab();

    // The moment the text lands the ring is still there, now fading — this is
    // the whole point of the settle class, so it is asserted, not assumed.
    await waitFor(() => expect(field).toHaveValue('Capot'));
    expect(field.parentElement).toHaveClass('animate-ai-settling');

    // ...and it does clear itself once the fade has run its course.
    await waitFor(() => expect(field.parentElement).not.toHaveClass('animate-ai-settling'), {
      timeout: AITO_AI_SETTLE_MS + 1000,
    });
  });

  it('stops glowing when the correction fails', async () => {
    const user = userEvent.setup();
    server.use(http.post('/api/v1/aito/proofread', () => HttpResponse.json({ detail: 'no key' }, { status: 409 })));
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot');
    await user.tab();

    await new Promise((r) => setTimeout(r, 30));
    expect(field.parentElement).not.toHaveClass('animate-ai-thinking');
  });

  it('does not overwrite an edit the user made while the correction was in flight', async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.post('/api/v1/aito/proofread', async () => {
        await gate;
        return HttpResponse.json({ text: 'Capot', model: 'm' });
      }),
    );
    render(<ControlledAiTextField />);

    const field = screen.getByLabelText('Task title');
    await user.click(field);
    await user.type(field, 'capot');
    await user.tab();
    // The user comes back and keeps typing before the answer lands.
    await user.click(field);
    await user.type(field, ' avant');
    release();

    await new Promise((r) => setTimeout(r, 30));
    expect(field).toHaveValue('capot avant');
  });

  it('marks itself as an AI field', async () => {
    render(<ControlledAiTextField initial="capot" />);
    expect(screen.getByTestId('ai-field-marker')).toBeInTheDocument();
  });

  it('renders a textarea in multiline mode', () => {
    render(<ControlledAiTextField multiline initial="note" />);
    expect(screen.getByLabelText('Task title').tagName).toBe('TEXTAREA');
  });
});
