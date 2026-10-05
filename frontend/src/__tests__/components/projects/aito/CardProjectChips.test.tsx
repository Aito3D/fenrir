import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { api, setAuthToken } from '../../../../api/client';
import { CardView } from '../../../../components/aito/CardView';
import type { AitoProject } from '../../../../api/client';

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
  client_social_network: null,
  client_social_handle: null,
  client_contact_person_id: null,
  client_contact_name: null,
  quote_id: null,
  quote_number: null,
  quote_date: null,
  quote_total: null,
  quote_url: null,
  quote_salesperson: null,
  quote_status: null,
  quote_accepted_at: null,
  quote_sent_at: null,
  invoice_status: null,
  invoice_balance: null,
  invoice_due_date: null,
  invoice_checked_at: null,
  quote_sync_state: 'idle',
  quote_invoiced: false,
  flag: null,
  client_contacted_at: null,
  due_date: null,
  quote_sync_error: null,
  quote_status_block: null,
  quote_status_remote: null,
  created_by: null,
  task_count: 0,
  tasks_total: 0,
  task_services: [],
  task_pending: [],
  steps_total: 0,
  steps_done: 0,
  print_minutes_pending: 0,
  task_steps: [{ services: ['scan'], done: [], title: 'Bracket' }, { services: ['impression'], done: [], title: 'Clip' }],
  move_lock: null,
  shipping_island: null,
  shipping_service: null,
  shipping_first_name: null,
  shipping_last_name: null,
  shipping_phone: null,
  shipping_price: null,
  shipping_lta: null,
  shipping_service_name: null,
  tracking_configured: false,
  quote_expiry_date: null,
  retainer_paid_total: null,
  customer_credit_total: null,
  payment_link: null,
  version: 1,
  created_at: '2026-07-27T00:00:00',
  updated_at: '2026-07-27T00:00:00',
};

const ORDER = project.id;
const link = (task_id: number, id: number, code: string, task_title: string | null = `Task ${task_id}`) => ({
  task_id, task_title, project: { id, code, name: `Project ${code}` }, sections: {}, deliveries: [] as number[],
});
const unlinkedTask = (task_id: number, task_title: string) => ({
  task_id, task_title, project: null, sections: {}, deliveries: [] as number[],
});
const fileDrop = () => ({ dataTransfer: { files: [new File(['x'], 'part.step')], types: ['Files'] } });

let codes: Record<string, string[]>;
let links: ReturnType<typeof link>[];
let posted: string[];

beforeEach(() => {
  codes = {};
  links = [];
  posted = [];
  server.use(
    http.get('/api/v1/aito/project-codes', () => HttpResponse.json(codes)),
    http.get(`/api/v1/aito/${ORDER}/project-links`, () => HttpResponse.json({ order_id: ORDER, tasks: links })),
    http.post('/api/v1/aito/tasks/:id/files', ({ params }) => {
      posted.push(String(params.id));
      return HttpResponse.json({ project_id: 7, results: [{ filename: 'part.step', section: 'modelisation', item_id: 1, item_name: 'part', revision_number: 1 }] });
    }),
  );
});

describe('card project chips', () => {
  it('shows the order codes', async () => {
    codes = { [ORDER]: ['P-0001', 'P-0002'] };
    render(<CardView project={project} onExpand={() => {}} />);
    expect(await screen.findByText('P-0001')).toBeInTheDocument();
    expect(screen.getByText('P-0002')).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d/)).not.toBeInTheDocument();
  });

  it('collapses the third code into +1', async () => {
    codes = { [ORDER]: ['P-0001', 'P-0002', 'P-0003'] };
    render(<CardView project={project} onExpand={() => {}} />);
    expect(await screen.findByText('+1')).toBeInTheDocument();
    expect(screen.queryByText('P-0003')).not.toBeInTheDocument();
  });

  it('shows no chips on a placeholder or overlay card', async () => {
    codes = { [ORDER]: ['P-0001'] };
    render(
      <>
        <CardView project={{ ...project, id: 99 }} onExpand={() => {}} />
        <CardView project={project} placeholder />
        <CardView project={project} overlay />
      </>,
    );
    codes = { [ORDER]: ['P-0001'], 99: ['P-0099'] };
    await screen.findByText('P-0099');
    expect(screen.queryByText('P-0001')).not.toBeInTheDocument();
  });
});

describe('card file drop', () => {
  const zone = () => screen.getByTestId('aito-card-shell');

  it('one linked task receives the files', async () => {
    links = [link(11, 7, 'P-0007')];
    const spy = vi.spyOn(api, 'dropFilesOnTask');
    render(<CardView project={project} onExpand={() => {}} />);
    fireEvent.drop(zone(), fileDrop());
    await waitFor(() => expect(posted).toEqual(['11']));
    expect(spy).toHaveBeenCalledWith(11, [expect.objectContaining({ name: 'part.step' })]);
    expect(await screen.findByText('1 file added to P-0007')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('the toast names the project the server stored the files in, not a stale cached link', async () => {
    links = [link(11, 7, 'P-0007')];
    server.use(
      http.post('/api/v1/aito/tasks/:id/files', () =>
        HttpResponse.json({
          project_id: 9,
          code: 'P-0009',
          results: [{ filename: 'part.step', section: 'modelisation', item_id: 1, item_name: 'part', revision_number: 1 }],
        }),
      ),
    );
    render(<CardView project={project} onExpand={() => {}} />);
    fireEvent.drop(zone(), fileDrop());
    expect(await screen.findByText('1 file added to P-0009')).toBeInTheDocument();
  });

  it('several linked tasks ask which, then post to the picked one', async () => {
    links = [link(11, 7, 'P-0007', 'Bracket'), unlinkedTask(13, 'Loose'), link(12, 8, 'P-0008', 'Clip')];
    render(<CardView project={project} onExpand={() => {}} />);
    fireEvent.drop(zone(), fileDrop());
    const chooser = await screen.findByRole('dialog', { name: 'Which task are these files for?' });
    expect(posted).toEqual([]);
    expect(within(chooser).getAllByRole('button').map((b) => b.textContent)).toEqual(['BracketP-0007', 'ClipP-0008']);
    await userEvent.click(within(chooser).getByRole('button', { name: /Clip/ }));
    await waitFor(() => expect(posted).toEqual(['12']));
  });

  it('a press outside the chooser closes it without uploading', async () => {
    links = [link(11, 7, 'P-0007'), link(12, 8, 'P-0008')];
    render(<CardView project={project} onExpand={() => {}} />);
    fireEvent.drop(zone(), fileDrop());
    await screen.findByRole('dialog', { name: 'Which task are these files for?' });
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posted).toEqual([]);
  });

  it('no linked task toasts and opens the card', async () => {
    const onExpand = vi.fn();
    render(<CardView project={project} onExpand={onExpand} />);
    fireEvent.drop(zone(), fileDrop());
    expect(await screen.findByText('Link a project to this task first')).toBeInTheDocument();
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });

  it('a non-file drag does nothing', async () => {
    links = [link(11, 7, 'P-0007')];
    render(<CardView project={project} onExpand={() => {}} />);
    const over = fireEvent.dragOver(zone(), { dataTransfer: { types: ['text/plain'] } });
    expect(over).toBe(true);
    fireEvent.drop(zone(), { dataTransfer: { files: [], types: ['text/plain'] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(posted).toEqual([]);
  });
});

describe('card file drop permissions', () => {
  const zone = () => screen.getByTestId('aito-card-shell');
  let meServed: boolean;

  const signInWith = (permissions: string[]) => {
    meServed = false;
    setAuthToken('test-token', 'session');
    server.use(
      http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
      http.get('*/api/v1/auth/me', () => {
        meServed = true;
        return HttpResponse.json({ id: 1, username: 'op', is_admin: false, permissions });
      }),
    );
  };

  afterEach(() => {
    setAuthToken(null);
  });

  it('drops with aito:update + projects:update + projects:read', async () => {
    signInWith(['aito:read', 'aito:update', 'projects:read', 'projects:update']);
    links = [link(11, 7, 'P-0007')];
    render(<CardView project={project} onExpand={() => {}} />);
    await waitFor(() => expect(meServed).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.drop(zone(), fileDrop());
    await waitFor(() => expect(posted).toEqual(['11']));
  });

  it('ignores the drop without projects:read (the links it needs are unreadable)', async () => {
    signInWith(['aito:read', 'aito:update', 'projects:update']);
    links = [link(11, 7, 'P-0007')];
    render(<CardView project={project} onExpand={() => {}} />);
    await waitFor(() => expect(meServed).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.drop(zone(), fileDrop());
    await new Promise((r) => setTimeout(r, 100));
    expect(posted).toEqual([]);
    expect(screen.queryByText('Link a project to this task first')).not.toBeInTheDocument();
  });
});
