import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/** The app's configured currency code, `'USD'` until Settings has loaded or
 *  if none is set.
 *
 *  Every Aito surface that prices something — NewProjectDrawer,
 *  ImportQuoteDrawer, TaskEditor, TaskRow, TaskStepFields, TaskStepList,
 *  ImpressionFields and ProjectDetailPanel — calls this hook rather than
 *  running its own `useQuery`. They all use the same `['settings']` key and
 *  60s `staleTime`, so React Query dedupes them onto one fetch shared with
 *  CalculatorPage's own lookup, not eight (or nine) separate ones. */
export function useCurrency(): string {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  return settings?.currency || 'USD';
}
