import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import type { CalcConfig } from '../utils/archivePricing';

const STALE_MS = 5 * 60 * 1000;

/** The pricing calculator's filaments, printers and defaults, for a card's cost estimate. Same
 *  query keys (and cache) as CalculatorPage, ArchivesPage and FileManagerPage; null while loading,
 *  without `calculator:read`, or until the calculator has a filament and a printer. */
export function useCalcConfig(): CalcConfig | null {
  const { hasPermission } = useAuth();
  const enabled = hasPermission('calculator:read');
  const { data: filaments } = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    enabled,
    retry: false,
    staleTime: STALE_MS,
  });
  const { data: printers } = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    enabled,
    retry: false,
    staleTime: STALE_MS,
  });
  const { data: defaults } = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    enabled,
    retry: false,
    staleTime: STALE_MS,
  });
  return useMemo(
    () => (filaments?.length && printers?.length && defaults ? { filaments, printers, defaults } : null),
    [filaments, printers, defaults],
  );
}
