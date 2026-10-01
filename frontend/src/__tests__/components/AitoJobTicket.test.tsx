import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../utils';
import { JobTicket } from '../../components/aito/JobTicket';
import { buildJobTicketHtml } from '../../components/aito/printJobTicket';
import { makeProject } from '../fixtures/aitoProject';
import { taskDraftFromAitoTask } from '../../utils/taskDraft';
import { formatMoney } from '../../utils/pricing';
import type { AitoTask, CalculatorFilament, CalculatorPrinter } from '../../api/client';

const baseTask = {
  id: 1,
  project_id: 41,
  position: 0,
  title: '',
  scan_description: null,
  modelisation_description: null,
  impression_description: null,
  usinage_description: null,
  maindoeuvre_description: null,
  scan_cost: null,
  modelisation_cost: null,
  usinage_cost: null,
  maindoeuvre_cost: null,
  impression_printer_id: null,
  impression_filament_id: null,
  impression_weight_g: null,
  impression_time_min: null,
  impression_quantity: 1,
  impression_color: null,
  impression_cost: null,
  impression_discount_pct: null,
  scan_quantity: null,
  modelisation_quantity: null,
  usinage_quantity: null,
  scan_discount_pct: null,
  modelisation_discount_pct: null,
  usinage_discount_pct: null,
  scan_done: false,
  modelisation_done: false,
  impression_done: false,
  usinage_done: false,
  maindoeuvre_done: false,
  created_at: '2026-09-01T00:00:00',
  updated_at: '2026-09-01T00:00:00',
} as unknown as AitoTask;

const project = makeProject({
  id: 41,
  quote_number: 'DEV26-2656',
  client_name: 'Client de passage',
  client_phone: '+689-87123456',
  description: 'Pièce carrosserie de BMW X3',
  due_date: '2026-10-09',
  // Naive UTC from the server; the ticket shows the LOCAL day it falls on.
  created_at: '2026-09-28T21:00:00',
});

const tasks = [
  taskDraftFromAitoTask({
    ...baseTask,
    id: 1,
    title: 'Aile avant',
    scan_cost: 3500,
    scan_quantity: 3,
    scan_done: true,
    impression_cost: 12345,
    impression_printer_id: 1,
    impression_filament_id: 7,
    impression_color: 'Noir',
    impression_quantity: 2,
    impression_weight_g: 40,
    impression_time_min: 95,
    impression_description: 'Remplissage 30 %',
  }),
  taskDraftFromAitoTask({
    ...baseTask,
    id: 2,
    title: 'Boite pelicule',
    usinage_cost: 31000,
    usinage_quantity: 4,
    usinage_description: 'Percer à 6 mm',
  }),
];

const printers = [{ id: 1, name: 'H2S' }] as CalculatorPrinter[];
const filaments = [{ id: 7, name: 'Sunlu PA6-CF' }] as CalculatorFilament[];
const now = new Date(2026, 9, 1, 14, 30);

const showTicket = (trackingUrl: string | null = 'https://shop.example/t/abc', printedBy = 'alice') =>
  render(
    <JobTicket
      project={project}
      tasks={tasks}
      printers={printers}
      filaments={filaments}
      trackingUrl={trackingUrl}
      printedBy={printedBy}
      now={now}
    />,
  );

describe('JobTicket', () => {
  it('heads the page with the card, the quote, the client and both dates', () => {
    showTicket();
    const header = screen.getByTestId('job-ticket-header');
    expect(header).toHaveTextContent('Job ticket');
    expect(header).toHaveTextContent('#41');
    expect(header).toHaveTextContent('DEV26-2656');
    expect(header).toHaveTextContent('Client de passage');
    expect(header).toHaveTextContent('+689-87123456');
    expect(header).toHaveTextContent(`Promised for${new Date(2026, 9, 9).toLocaleDateString('en', { dateStyle: 'medium' })}`);
    expect(header).toHaveTextContent(`Created${new Date(Date.UTC(2026, 8, 28, 21)).toLocaleDateString('en', { dateStyle: 'medium' })}`);
    expect(screen.getByText('Pièce carrosserie de BMW X3')).toBeInTheDocument();
  });

  it('lists every enabled step of every task, with a tick box and its details, and no disabled one', () => {
    showTicket();
    const blocks = screen.getAllByTestId('job-ticket-task');
    expect(blocks).toHaveLength(2);

    expect(within(blocks[0]).getByText('Aile avant')).toBeInTheDocument();
    const firstSteps = within(blocks[0]).getAllByTestId('job-ticket-step');
    expect(firstSteps.map((s) => s.getAttribute('data-service'))).toEqual(['scan', 'impression']);
    expect(firstSteps[0]).toHaveTextContent('Scan');
    expect(firstSteps[0]).toHaveTextContent('Qty 3');
    expect(firstSteps[1]).toHaveTextContent('Printing');
    expect(firstSteps[1]).toHaveTextContent('H2S');
    expect(firstSteps[1]).toHaveTextContent('Sunlu PA6-CF · Noir');
    expect(firstSteps[1]).toHaveTextContent('Qty 2');
    expect(firstSteps[1]).toHaveTextContent('Weight 40 g');
    expect(firstSteps[1]).toHaveTextContent('Time 95 min');
    expect(firstSteps[1]).toHaveTextContent('Remplissage 30 %');
    // A step already done arrives ticked; the rest are empty boxes to fill.
    expect(within(firstSteps[0]).getByTestId('job-ticket-tick')).toHaveTextContent('✓');
    expect(within(firstSteps[1]).getByTestId('job-ticket-tick').textContent).toBe('');

    const secondSteps = within(blocks[1]).getAllByTestId('job-ticket-step');
    expect(secondSteps).toHaveLength(1);
    expect(secondSteps[0]).toHaveTextContent('Machining');
    expect(secondSteps[0]).toHaveTextContent('Qty 4');
    expect(secondSteps[0]).toHaveTextContent('Percer à 6 mm');
    expect(screen.queryByText('Modeling')).not.toBeInTheDocument();
  });

  it('shows no money anywhere', () => {
    const { container } = showTicket();
    expect(screen.queryByText(/FCFP|XPF|\$|€/)).toBeNull();
    for (const value of [3500, 12345, 31000, 46845]) {
      expect(container.textContent).not.toContain(formatMoney(value, 'XPF', false));
    }
  });

  it('prints a QR of the tracking link only when the card has one', () => {
    const { unmount } = showTicket();
    expect(screen.getByTestId('job-ticket-qr').querySelector('svg')).not.toBeNull();
    unmount();
    showTicket(null);
    expect(screen.queryByTestId('job-ticket-qr')).toBeNull();
  });

  it('signs the footer with the date and the user who printed it', () => {
    showTicket();
    const stamp = now.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
    expect(screen.getByTestId('job-ticket-footer')).toHaveTextContent(`Printed ${stamp} by alice`);
  });

  it('drops the "by" when nobody is signed in', () => {
    showTicket(null, '');
    const stamp = now.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
    expect(screen.getByTestId('job-ticket-footer').textContent).toBe(`Printed ${stamp}`);
  });
});

describe('buildJobTicketHtml', () => {
  it('wraps the ticket in a standalone A4 document with its own print styles', () => {
    const html = buildJobTicketHtml({
      project,
      tasks,
      printers,
      filaments,
      trackingUrl: 'https://shop.example/t/abc',
      printedBy: 'alice',
      now,
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@page');
    expect(html).toContain('A4');
    expect(html).toContain('Aile avant');
    expect(html).toContain('<svg');
    expect(html).not.toMatch(/FCFP|XPF/);
  });
});
