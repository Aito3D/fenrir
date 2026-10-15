import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Pins the exact failure toasts of the files panel actions and the re-slice start:
// `{label}: {message}` for an Error, `{label}: ` (nothing after the space) otherwise.
const showToast = vi.fn();
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));

import { api } from '../../../api/client';
import { createTestQueryClient } from '../../utils';
import { useFileActions } from '../../../components/projects/files/useFileActions';
import { useResliceJobs } from '../../../components/projects/reslice/useResliceJobs';

function wrapper({ children }: { children: ReactNode }) {
  const client = createTestQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  showToast.mockClear();
  vi.spyOn(api, 'getProjectTree').mockResolvedValue({ project_id: 7, code: 'P-0007', sections: [] } as never);
});
afterEach(() => vi.restoreAllMocks());

describe('failure toast pins', () => {
  it.each([
    [new Error('boom'), 'Could not save: boom'],
    ['nope', 'Could not save: '],
    [new Error(''), 'Could not save: '],
  ])('useFileActions run (save key) with %s', async (err, text) => {
    vi.spyOn(api, 'renameProjectItem').mockRejectedValue(err);
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.renameItem(20, 'x'));
    expect(showToast.mock.calls).toEqual([[text, 'error']]);
  });

  it.each([
    [new Error('too big'), 'Upload failed: too big'],
    [42, 'Upload failed: '],
  ])('useFileActions run (upload key) with %s', async (err, text) => {
    vi.spyOn(api, 'addProjectRevisionFiles').mockRejectedValue(err);
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.addFiles(20, 3, [new File(['x'], 'a.3mf')]));
    expect(showToast.mock.calls).toEqual([[text, 'error']]);
  });

  it.each([
    [new Error('gone'), 'Could not save: gone'],
    [undefined, 'Could not save: '],
  ])('useFileActions download with %s', async (err, text) => {
    vi.spyOn(api, 'downloadProjectRevision').mockRejectedValue(err);
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.download(3, 4, 'a.3mf'));
    expect(showToast.mock.calls).toEqual([[text, 'error']]);
  });

  it.each([
    [new Error('Sidecar down'), 'Could not start slicing: Sidecar down'],
    [{ message: 'not an Error' }, 'Could not start slicing: '],
  ])('useResliceJobs start with %s', async (err, text) => {
    vi.spyOn(api, 'resliceProjectRevision').mockRejectedValue(err);
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, undefined));
    expect(showToast.mock.calls).toEqual([[text, 'error']]);
  });
});
