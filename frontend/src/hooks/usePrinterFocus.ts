import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';
import { useDeepLinkParam } from './useDeepLinkParam';

const FOCUS_RING_MS = 2000;

/**
 * The Printers page's `?focus=7` link: once the printers have loaded, scroll
 * that printer's card into view and return its id for two seconds (the card
 * rings while it is focused). An unknown id toasts. Either way the parameter
 * leaves the URL.
 */
export function usePrinterFocus(printers: { id: number }[] | undefined): number | null {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [focusParam, clearFocusParam] = useDeepLinkParam('focus');
  const [focusedPrinterId, setFocusedPrinterId] = useState<number | null>(null);

  useEffect(() => {
    if (focusParam === null || !printers) return;
    clearFocusParam();
    const id = Number(focusParam);
    if (printers.some((p) => p.id === id)) setFocusedPrinterId(id);
    else showToast(t('printers.focusGone'), 'error');
  }, [focusParam, printers, clearFocusParam, showToast, t]);

  useEffect(() => {
    if (focusedPrinterId === null) return;
    document.getElementById(`printer-card-${focusedPrinterId}`)?.scrollIntoView({ block: 'center' });
    const timer = setTimeout(() => setFocusedPrinterId(null), FOCUS_RING_MS);
    return () => clearTimeout(timer);
  }, [focusedPrinterId]);

  return focusedPrinterId;
}
