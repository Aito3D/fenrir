import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink, FileInput, X } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoTaskCreate, ZohoEstimateSummary, ZohoQuotePreview } from '../../api/client';
import { Button } from '../Button';
import { Money } from '../calculator/shared';
import { QuoteCombobox } from './QuoteCombobox';
import { ServiceBadges } from './ServiceBadges';
import { inputCls, labelCls } from '../formStyles';

export interface ImportQuoteModalProps {
  onClose: () => void;
  onImport: (payload: { description: string; preview: ZohoQuotePreview }) => void;
  submitting?: boolean;
}

/** Which services a preview task has enabled, in canonical order. Mirrors
 *  `enabledServices` in components/aito/services.ts, but reads the API shape
 *  rather than a TaskDraft. A NULL cost means disabled; 0 stays meaningful as
 *  free, so this is a null check, never a truthiness test. */
function servicesOf(task: AitoTaskCreate): string[] {
  const enabled: string[] = [];
  if (task.scan_cost !== null) enabled.push('scan');
  if (task.modelisation_cost !== null) enabled.push('modelisation');
  if (task.impression_cost !== null) enabled.push('impression');
  if (task.usinage_cost !== null) enabled.push('usinage');
  return enabled;
}

function taskTotal(task: AitoTaskCreate): number {
  return (
    (task.scan_cost ?? 0) + (task.modelisation_cost ?? 0) + (task.impression_cost ?? 0) + (task.usinage_cost ?? 0)
  );
}

/** Pick a quote, see what it becomes, import it.
 *
 *  Read-only except for the project description: the tasks shown here are the
 *  exact payload that gets posted, so what the user approves is what is
 *  created. Everything else is editable afterwards in the detail panel. */
export function ImportQuoteModal({ onClose, onImport, submitting = false }: ImportQuoteModalProps) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<ZohoEstimateSummary | null>(null);
  const [description, setDescription] = useState('');
  // Which quote's suggestion is currently in the textarea, so re-rendering
  // never overwrites what the user typed.
  const [seededFor, setSeededFor] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });
  const zohoNotConfigured = statusQuery.data?.configured === false;

  const previewQuery = useQuery({
    queryKey: ['zoho-quote-preview', selected?.id],
    queryFn: () => api.getZohoQuotePreview(selected!.id),
    enabled: selected !== null,
  });
  const preview = previewQuery.data ?? null;

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
  const configuredCurrency = settings?.currency || 'USD';

  // Seed the description once per quote.
  useEffect(() => {
    if (preview && seededFor !== preview.quote.id) {
      setDescription(preview.suggested_description);
      setSeededFor(preview.quote.id);
    }
  }, [preview, seededFor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const currency = preview?.quote.currency_code || configuredCurrency;
  const currencyMismatch = Boolean(preview && preview.quote.currency_code !== configuredCurrency);
  const projectTotal = (preview?.tasks ?? []).reduce((sum, task) => sum + taskTotal(task), 0);
  const hasTasks = (preview?.tasks.length ?? 0) > 0;
  const canImport = Boolean(preview) && hasTasks && description.trim().length > 0 && !submitting;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-bambu-dark-secondary rounded-xl w-full max-w-3xl border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">{t('aito.importTitle')}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (canImport && preview) onImport({ description: description.trim(), preview });
          }}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="p-4 overflow-y-auto flex-1 space-y-4">
            {zohoNotConfigured ? (
              <div>
                <label className={labelCls}>{t('aito.quoteSearchLabel')}</label>
                <div className="p-3 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-sm text-bambu-gray">
                  {t('aito.zohoNotConfigured')}{' '}
                  <Link to="/settings?tab=zoho" className="text-bambu-green hover:underline">
                    {t('aito.zohoConfigureLink')}
                  </Link>
                </div>
              </div>
            ) : (
              <QuoteCombobox selected={selected} onSelect={setSelected} />
            )}

            {previewQuery.isError && (
              <p className="text-sm text-status-error">{t('aito.quoteLoadFailed')}</p>
            )}

            {preview && (
              <>
                <div className="border-t border-bambu-dark-tertiary pt-4 flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">
                      {preview.quote.number} · {preview.client.name}
                    </p>
                    <p className="text-xs text-bambu-gray">
                      {[
                        preview.quote.date
                          ? new Date(preview.quote.date + 'T00:00:00').toLocaleDateString(i18n.language)
                          : '',
                        preview.quote.status,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <a
                    href={preview.quote.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('aito.quoteOpenInZoho')}
                    className="flex items-center gap-1 text-xs text-bambu-gray hover:text-bambu-green transition-colors flex-shrink-0"
                  >
                    <Money currency={currency} value={preview.quote.total} />
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                {preview.existing_project_id !== null && (
                  <p className="flex items-center gap-2 text-sm text-status-warning">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    {t('aito.quoteAlreadyImported', { id: preview.existing_project_id })}
                  </p>
                )}

                {currencyMismatch && (
                  <p className="text-xs text-bambu-gray">
                    {t('aito.quoteCurrencyMismatch', {
                      code: preview.quote.currency_code,
                      configured: configuredCurrency,
                    })}
                  </p>
                )}

                {!hasTasks && (
                  <p className="flex items-center gap-2 text-sm text-status-error">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    {t('aito.quoteNoServiceLines')}
                  </p>
                )}

                <div>
                  <label htmlFor="aito-import-description" className={labelCls}>
                    {t('aito.productDescription')}
                  </label>
                  <textarea
                    id="aito-import-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    className={`${inputCls} resize-none`}
                  />
                </div>

                {preview.tasks.length > 0 && (
                  <ul className="space-y-2">
                    {preview.tasks.map((task, index) => (
                      <li key={index} className="rounded-lg bg-bambu-dark p-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-sm text-white truncate">
                            {task.title || t('aito.taskFallbackName', { n: index + 1 })}
                          </p>
                          <Money
                            currency={currency}
                            value={taskTotal(task)}
                            className="text-xs font-medium text-bambu-green flex-shrink-0"
                          />
                        </div>
                        <ServiceBadges services={servicesOf(task)} className="mt-1.5" />
                        {task.description && (
                          <p className="mt-1.5 text-xs text-bambu-gray whitespace-pre-wrap break-words">
                            {task.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {preview.skipped_lines.length > 0 && (
                  <div className="border-t border-bambu-dark-tertiary pt-3 space-y-1">
                    <p className="text-xs uppercase tracking-wide text-bambu-gray">{t('aito.quoteSkipped')}</p>
                    {preview.skipped_lines.map((line) => (
                      <p key={`${line.sku}-${line.name}`} className="flex justify-between gap-2 text-xs text-bambu-gray">
                        <span className="truncate">{[line.sku, line.name].filter(Boolean).join(' · ')}</span>
                        <Money currency={currency} value={line.amount} className="flex-shrink-0" />
                      </p>
                    ))}
                    <p className="text-xs text-bambu-gray">
                      {t('aito.quoteTotals', {
                        project: projectTotal.toLocaleString(i18n.language),
                        quote: preview.quote.total.toLocaleString(i18n.language),
                      })}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="p-4 border-t border-bambu-dark-tertiary flex justify-end gap-2 flex-shrink-0">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canImport}>
              <FileInput className="w-4 h-4 mr-2" />
              {preview !== null && preview.existing_project_id !== null
                ? t('aito.quoteImportAgain')
                : t('aito.quoteImport')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
