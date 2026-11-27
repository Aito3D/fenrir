import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { RevenueLabor, type LaborProvider } from '../../../components/revenue/RevenueLabor';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const alice: LaborProvider = { name: 'Alice', hourlyRate: 1500, hoursPerDay: 8, daysPerWeek: 5, since: null };

function setup(canManage = true) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    json(init?.method === 'PUT' ? JSON.parse(String(init.body)) : { providers: [alice] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <RevenueLabor canManage={canManage} onChanged={onChanged} />
    </ToastProvider>,
  );
  return { fetchMock, onChanged };
}

afterEach(() => vi.unstubAllGlobals());

describe('RevenueLabor', () => {
  it('shows each provider with its monthly cost and the total', async () => {
    setup();
    await screen.findByDisplayValue('Alice');
    // 1500 × 8 h × 5 days × 52 weeks / 12 months.
    expect(screen.getAllByText('260.000 FCP')).toHaveLength(2);
  });

  it('saves the whole list once a valid row is added', async () => {
    const { fetchMock, onChanged } = setup();
    await screen.findByDisplayValue('Alice');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add a person' }));
    const save = screen.getByRole('button', { name: 'Save' });
    // A row without a name is not sent.
    expect(save).toBeDisabled();
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Name' })[1], { target: { value: 'Bob' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Hourly rate · Bob' }), { target: { value: '1800' } });
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/api/v1/revenue/labor');
    expect(JSON.parse(String(put[1]!.body)).providers).toEqual([alice, { ...alice, name: 'Bob', hourlyRate: 1800 }]);
  });

  it('is read-only without the manage right', async () => {
    setup(false);
    expect(await screen.findByDisplayValue('Alice')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
