import { describe, it, expect, vi, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../utils';
import { ForceSyncModal } from '../../components/aito/ForceSyncModal';
import { api, ApiError, type AitoProject, type AitoForceSyncReport } from '../../api/client';

const project = { id: 12 } as unknown as AitoProject;

const REPORT: AitoForceSyncReport = {
  steps: [
    { key: 'quote', outcome: 'in_sync', detail: {} },
    { key: 'credit', outcome: 'fixed', detail: { before: 500, after: 7000 } },
    { key: 'invoice', outcome: 'failed', detail: { reason: 'upstream', message: 'Zoho said no' } },
    { key: 'payment_links', outcome: 'skipped', detail: { reason: 'not_invoiced' } },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('ForceSyncModal', () => {
  it('shows the running state and the four step names while the request is pending', () => {
    vi.spyOn(api, 'forceSyncAitoProject').mockImplementation(() => new Promise(() => {}));
    render(<ForceSyncModal project={project} currency="XPF" onClose={() => {}} />);
    expect(screen.getAllByText('Checking…')).toHaveLength(4);
    for (const name of ['Quote', 'Customer credit', 'Invoice', 'Payment links']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('renders each outcome once the report arrives', async () => {
    vi.spyOn(api, 'forceSyncAitoProject').mockResolvedValue(REPORT);
    render(<ForceSyncModal project={project} currency="XPF" onClose={() => {}} />);
    expect(await screen.findByText('In sync')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Zoho said no')).toBeInTheDocument();
    expect(screen.getByText('Not invoiced yet')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
  });

  it('shows a rejected request inline and no step rows', async () => {
    vi.spyOn(api, 'forceSyncAitoProject').mockRejectedValue(new ApiError('Too many sync checks, wait a bit', 429));
    render(<ForceSyncModal project={project} currency="XPF" onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sync checks, wait a bit');
    expect(screen.queryByText('In sync')).not.toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
  });

  it('refreshes the invoice and the board on success', async () => {
    vi.spyOn(api, 'forceSyncAitoProject').mockResolvedValue(REPORT);
    const spy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    render(<ForceSyncModal project={project} currency="XPF" onClose={() => {}} />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['aito-invoice', 12] }));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });

  it('fires the request exactly once, even under StrictMode', async () => {
    const spy = vi.spyOn(api, 'forceSyncAitoProject').mockResolvedValue(REPORT);
    render(
      <StrictMode>
        <ForceSyncModal project={project} currency="XPF" onClose={() => {}} />
      </StrictMode>,
    );
    await screen.findByText('In sync');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', async () => {
    vi.spyOn(api, 'forceSyncAitoProject').mockResolvedValue(REPORT);
    const onClose = vi.fn();
    render(<ForceSyncModal project={project} currency="XPF" onClose={onClose} />);
    await screen.findByText('In sync');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
