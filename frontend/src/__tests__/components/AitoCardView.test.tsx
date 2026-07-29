import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { CardView } from '../../components/aito/CardView';
import type { AitoProject } from '../../api/client';

const project: AitoProject = {
  id: 12,
  description: 'Support de caméra',
  column: 'devis',
  position: 0,
  status: 'active',
  client_id: 'z1',
  client_name: 'ACME SARL',
  client_phone: '+689-87123456',
  client_email: 'hi@acme.pf',
  client_is_company: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

describe('CardView', () => {
  it('puts the client name in the header and never renders phone or email', () => {
    render(<CardView project={project} onExpand={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('ACME SARL')).toBeInTheDocument();
    expect(screen.queryByText(/87123456/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hi@acme\.pf/)).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('falls back to the no-client label when the card has no client', () => {
    render(<CardView project={{ ...project, client_name: null }} onExpand={vi.fn()} />);
    expect(screen.getByText(/no client|sans client/i)).toBeInTheDocument();
  });

  it('opens from the body, and the body is reachable by keyboard', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<CardView project={project} onExpand={onExpand} onDelete={vi.fn()} />);
    const body = screen.getByRole('button', { name: /Support de caméra/ });
    await user.click(body);
    expect(onExpand).toHaveBeenCalledTimes(1);

    body.focus();
    await user.keyboard('{Enter}');
    expect(onExpand).toHaveBeenCalledTimes(2);
  });

  it('does not open when the header or the grip is clicked', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={project}
        onExpand={onExpand}
        onDelete={vi.fn()}
        dragHandleRef={vi.fn()}
        dragHandleProps={{}}
      />,
    );
    await user.click(screen.getByText('ACME SARL'));
    await user.click(screen.getByRole('button', { name: /drag|glisser/i }));
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('renders a static grip with no button in the drag overlay', () => {
    render(<CardView project={project} overlay />);
    expect(screen.queryByRole('button', { name: /drag|glisser/i })).not.toBeInTheDocument();
  });

  it('shows a badge per enabled service, the task count and the total', async () => {
    render(
      <CardView
        project={{ ...project, task_count: 2, tasks_total: 20200, task_services: ['modelisation', 'impression'] }}
        onExpand={vi.fn()}
      />,
    );
    expect(await screen.findByText('Modeling')).toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.queryByText('Scan')).not.toBeInTheDocument();
    expect(screen.getByText(/2 tasks|2 tâches/i)).toBeInTheDocument();
    // Matched on the digits, not the whole formatted string: the currency and
    // separators come from formatMoney and the settings stub, and pinning them
    // here would make this a test of formatMoney.
    expect(screen.getByText(/20[,\s.]?200/)).toBeInTheDocument();
  });

  it('renders no summary row at all for a project with no tasks', () => {
    render(
      <CardView
        project={{ ...project, task_count: 0, tasks_total: 0, task_services: [] }}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByText(/0 tasks|0 tâches/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Scan')).not.toBeInTheDocument();
    expect(screen.queryByText('Printing')).not.toBeInTheDocument();
  });

  it('shows the same summary in the drag overlay, which has no body button', async () => {
    // CardView inserts the summary at two points — inside the body <button>
    // when `onExpand` is passed, and inside a plain <div> for the DragOverlay
    // clone, which gets neither `onExpand` nor `onDelete`. Every other summary
    // test above passes `onExpand`, so without this one the overlay's
    // insertion point could be dropped and the suite would stay green while a
    // dragged card visibly lost its badges, count and total.
    render(
      <CardView
        project={{ ...project, task_count: 2, tasks_total: 20200, task_services: ['modelisation', 'impression'] }}
        overlay
      />,
    );
    expect(await screen.findByText('Modeling')).toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.getByText(/2 tasks|2 tâches/i)).toBeInTheDocument();
    expect(screen.getByText(/20[,\s.]?200/)).toBeInTheDocument();
    // The overlay clone really is the no-onExpand branch: nothing here is a
    // button, so this cannot have been the body-button path in disguise.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('keeps the summary inside the body button, so it opens the panel', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(
      <CardView
        project={{ ...project, task_count: 1, tasks_total: 4000, task_services: ['scan'] }}
        onExpand={onExpand}
      />,
    );
    await user.click(await screen.findByText('Scan'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('shows the quote number in the footer for an imported card', () => {
    render(
      <CardView
        project={{ ...project, quote_number: 'DEV26-2462', quote_id: 'e2' }}
        onExpand={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('DEV26-2462')).toBeInTheDocument();
    // The chip is not a link — the card body is a <button> and the footer
    // already carries hold-to-delete.
    expect(document.querySelector('a[href*="zoho"]')).toBeNull();
  });

  it('shows no quote chip on a manually created card', () => {
    render(<CardView project={project} onExpand={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByText(/DEV26-/)).not.toBeInTheDocument();
  });
});
