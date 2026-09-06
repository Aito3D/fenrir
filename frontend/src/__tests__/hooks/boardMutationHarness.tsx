/**
 * Shared harness for the board-mutation hook test files (useContactedMutation,
 * useFlagMutation, useColumnMoveMutation, useDueDateMutation): each of those
 * files independently pasted the same react-i18next mock (returning the raw
 * key), the same ToastContext mock (a plain `showToastMock` spy), the same
 * useRevertFlash mock (the wrapper imports `flashRevert` as a direct binding,
 * so `vi.spyOn` on the namespace would patch an object nobody reads — the
 * module has to be mocked instead, spreading the original so anything else
 * re-exported stays real), and the same `renderXHook(project)` helper that
 * builds a `QueryClient`, seeds `['aito-projects']`, and wraps in
 * `QueryClientProvider`.
 *
 * `vi.mock(...)` calls are hoisted to the top of the file they appear in, so
 * this module cannot own them itself — a factory imported from here and
 * referenced directly inside another file's `vi.mock(...)` call would run
 * into the import's temporal-dead-zone before the mocked module is ever
 * requested. Each test file therefore keeps its own three one-line
 * `vi.mock(...)` calls, but the calls delegate to the factories exported
 * here instead of repeating the object literals.
 */
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import type { AitoProject } from '../../api/client';

export const showToastMock = vi.fn();
export const flashRevertMock = vi.fn();

/** Factory for `vi.mock('react-i18next', i18nKeyTranslationFactory)`. */
export function i18nKeyTranslationFactory() {
  return { useTranslation: () => ({ t: (key: string) => key }) };
}

/** Factory for `vi.mock('../../contexts/ToastContext', toastContextMockFactory)`. */
export function toastContextMockFactory() {
  return { useToast: () => ({ showToast: showToastMock }) };
}

/**
 * Factory for `vi.mock('../../hooks/useRevertFlash', revertFlashMockFactory)`.
 * Spreads the real module so anything else it exports (e.g. `useIsReverting`)
 * stays real; only `flashRevert` is replaced.
 */
export async function revertFlashMockFactory() {
  const actual = await import('../../hooks/useRevertFlash');
  return { ...actual, flashRevert: flashRevertMock };
}

/** Shared `beforeEach` body for the board-mutation hook test files. */
export function resetBoardMutationHarness() {
  __resetBoardSync();
  vi.restoreAllMocks();
  showToastMock.mockClear();
  flashRevertMock.mockClear();
}

/**
 * Builds a `QueryClient`, optionally seeds `['aito-projects']` with `project`,
 * wraps in `QueryClientProvider`, and renders `useHook`.
 */
export function renderBoardMutationHook<T>(
  useHook: () => T,
  project: AitoProject,
  { seedCache = true }: { seedCache?: boolean } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (seedCache) {
    client.setQueryData(['aito-projects'], [project]);
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(useHook, { wrapper });
  return { client, result };
}
