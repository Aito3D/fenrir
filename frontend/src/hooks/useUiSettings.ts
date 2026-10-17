import { useQuery } from '@tanstack/react-query';
import { api, type UiSettings } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

/**
 * The install settings a page needs to render, for any signed-in user.
 *
 * GET /settings needs settings:read, and a user without it got a 403 that left
 * every value at its fallback. Such a user reads the subset served without
 * that permission instead; everyone else keeps the full settings, under the
 * same query key as before.
 */
export function useUiSettings(options: { enabled?: boolean; staleTime?: number } = {}) {
  const { hasPermission } = useAuth();
  return useQuery<UiSettings>({
    ...uiSettingsQuery(hasPermission('settings:read')),
    ...options,
  });
}

/** useUiSettings' key and fetcher, for a one-off `queryClient.fetchQuery` at click time. */
export function uiSettingsQuery(readsAll: boolean) {
  return {
    queryKey: readsAll ? ['settings'] : ['ui-settings'],
    queryFn: (readsAll ? () => api.getSettings() : () => api.getUiSettings()) as () => Promise<UiSettings>,
  };
}

/** Whether G-code snippets are set up, from either form of the settings. */
export function hasGcodeSnippets(settings: UiSettings | undefined): boolean {
  return !!(settings?.gcode_snippets || settings?.has_gcode_snippets);
}
