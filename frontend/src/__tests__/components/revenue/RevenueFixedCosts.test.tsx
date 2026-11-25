import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { RevenueFixedCosts } from '../../../components/revenue/RevenueFixedCosts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const rent = { label: 'Loyer', monthly: 120000 };

function setup(canManage = true) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    json(init?.method === 'PUT' ? JSON.parse(String(init.body)) : { costs: [rent] }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <RevenueFixedCosts canManage={canManage} onChanged={onChanged} onClose={vi.fn()} returnFocus={vi.fn()} />
    </ToastProvider>,
  );
  return { fetchMock, onChanged };
}

afterEach(() => vi.unstubAllGlobals());

describe('RevenueFixedCosts', () => {
  it('shows each charge and the monthly total', async () => {
    setup();
    await screen.findByDisplayValue('Loyer');
    expect(screen.getByText('120.000 FCP')).toBeInTheDocument();
    expect(screen.getByText(/^\d,\d FCP\/min$/)).toBeInTheDocument();
  });

  it('saves the whole list once a valid row is added', async () => {
    const { fetchMock, onChanged } = setup();
    await screen.findByDisplayValue('Loyer');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add a charge' }));
    // A row without a label is not sent.
    expect(save).toBeDisabled();
    fireEvent.change(screen.getAllByRole('textbox', { name: 'Charge' })[1], { target: { value: 'Assurance' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Per month · Assurance' }), { target: { value: '8000' } });
    fireEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/api/v1/revenue/fixed-costs');
    expect(JSON.parse(String(put[1]!.body))).toEqual({ costs: [rent, { label: 'Assurance', monthly: 8000 }] });
  });

  it('is read-only without the manage right', async () => {
    setup(false);
    expect(await screen.findByDisplayValue('Loyer')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
