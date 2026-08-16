import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '../utils';
import userEvent from '@testing-library/user-event';
import { AiSummaryPanel } from '../../components/aito/AiSummaryPanel';
import type { AiSummaryPanelProps } from '../../components/aito/AiSummaryPanel';
import { emptyTaskDraft } from '../../utils/taskDraft';
import { api } from '../../api/client';

// Wraps AiSummaryPanel with the shared provider tree (`render` from
// `__tests__/utils.tsx`, the same wrapper NewProjectModal.test.tsx uses).
function panelEl(props: AiSummaryPanelProps) {
  return <AiSummaryPanel {...props} />;
}

function renderPanel(props: AiSummaryPanelProps) {
  return render(panelEl(props));
}

vi.mock('../../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../api/client')>();
  return { ...mod, api: { ...mod.api, summarizeAitoProject: vi.fn() } };
});

const tasks = [{ ...emptyTaskDraft(), title: 'Capot', impressionCost: 120 }];

describe('AiSummaryPanel', () => {
  // Reset in afterEach, not beforeEach: resetting the mock at the start of a
  // test that then mounts a component whose effect calls it (and rejects)
  // reproducibly trips a Vitest 4.1.8 false "unhandled rejection" failure —
  // isolated and confirmed unrelated to this component's logic (mockReset OR
  // mockClear immediately before such a render both trigger it; the same
  // reset call placed in afterEach does not). Per-test isolation of
  // mock.calls is still exact, just shifted to the trailing edge.
  afterEach(() => vi.mocked(api.summarizeAitoProject).mockReset());

  it('waits idle until the nonce bumps, then shows the generated summary', async () => {
    vi.mocked(api.summarizeAitoProject).mockResolvedValue({ summary: 'Résumé.', model: 'mistralai/mistral-small' });
    const onChange = vi.fn();
    const { rerender } = renderPanel({ tasks, value: '', edited: false, onChange, generateNonce: 0 });
    expect(screen.getByText(/Generated when you reach the client step/)).toBeInTheDocument();
    expect(api.summarizeAitoProject).not.toHaveBeenCalled();
    rerender(panelEl({ tasks, value: '', edited: false, onChange, generateNonce: 1 }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Résumé.', false));
  });

  it('does not regenerate while edited, but the regenerate button does', async () => {
    vi.mocked(api.summarizeAitoProject).mockResolvedValue({ summary: 'Neuf.', model: 'm' });
    const onChange = vi.fn();
    const { rerender } = renderPanel({ tasks, value: 'À moi.', edited: true, onChange, generateNonce: 1 });
    rerender(panelEl({ tasks, value: 'À moi.', edited: true, onChange, generateNonce: 2 }));
    expect(api.summarizeAitoProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Neuf.', false));
  });

  it('settles the generated summary in with the rise entrance', async () => {
    // The shimmer bridges the wait; the answer must not then pop in on a
    // single frame. The wrapper remounts out of the pending branch on every
    // (re)generation, so the entrance re-fires each time without a key.
    vi.mocked(api.summarizeAitoProject).mockResolvedValue({ summary: 'Résumé.', model: 'm' });
    const onChange = vi.fn();
    renderPanel({ tasks, value: 'Résumé.', edited: false, onChange, generateNonce: 1 });
    await waitFor(() =>
      expect(screen.getByLabelText(/summary/i).closest('.animate-rise')).not.toBeNull(),
    );
  });

  it('falls back to an editable enumeration when the API fails', async () => {
    vi.mocked(api.summarizeAitoProject).mockRejectedValue(new Error('409'));
    const onChange = vi.fn();
    renderPanel({ tasks, value: '', edited: false, onChange, generateNonce: 1 });
    await waitFor(() => expect(screen.getByText(/AI unavailable/)).toBeInTheDocument());
    // Seeded with the fallback enumeration so create never ships empty:
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('Capot'), false);
  });
});
