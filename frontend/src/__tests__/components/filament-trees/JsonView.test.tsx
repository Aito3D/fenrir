import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JsonView } from '../../../components/filament-trees/JsonView';
import { api } from '../../../api/client';
import type { FilamentPreset } from '../../../api/client';

function renderView(names: string[], presets: Array<{ name: string; content: string }>) {
  vi.spyOn(api, 'getFilamentPresets').mockResolvedValue(presets as unknown as FilamentPreset[]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JsonView rows={[]} leafNames={names} />
    </QueryClientProvider>,
  );
}

describe('JsonView leaf profile lookup', () => {
  const names = ['T - Red @H2S 0.6', 'T @H2S 0.6'];

  it('falls back to the colour-less leaf and matches a merged nozzle group', async () => {
    renderView(names, [
      { name: 'T @H2S 0.4', content: 'wrong nozzle' },
      { name: 'T @H2S 0.4+0.6', content: 'shared' },
    ]);
    expect(await screen.findByText('shared')).toBeInTheDocument();
  });

  it("prefers the colour's own leaf", async () => {
    renderView(names, [
      { name: 'T @H2S 0.6', content: 'shared' },
      { name: 'T - Red @H2S 0.6', content: 'own' },
    ]);
    expect(await screen.findByText('own')).toBeInTheDocument();
  });
});
