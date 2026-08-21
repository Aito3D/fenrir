import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, ExternalLink, FileInput, X } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoTaskCreate, ZohoEstimateSummary } from '../../api/client';
import { Money } from '../calculator/shared';
import { Line } from './CreateChecklist';
import type { ChecklistState } from './CreateChecklist';
import { QuoteResultList } from './QuoteResultList';
import { AITO_SERVICE_LABEL_KEYS } from './services';
import { ServiceBadges } from './ServiceBadges';
import { focusRingCls, inputCls, labelCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import type { ZohoQuotePreview } from '../../api/client';
import { SERVICES, summariseTasks, taskCost } from '../../utils/aitoBoardRules';
import type { TaskLike } from '../../utils/aitoBoardRules';

export interface ImportQuoteDrawerProps {
  onClose: () => void;
  onImport: (payload: { description: string; preview: ZohoQuotePreview }) => void;
  submitting?: boolean;
}

/** Adapts a preview task's snake_case `AitoTaskCreate` shape to the canonical
 *  `TaskLike` `aitoBoardRules.ts` operates on, so this drawer can delegate to
 *  `taskCost`/`summariseTasks` instead of re-implementing their null-cost and
 *  per-service discount rules. `*_done` defaults to `false` server-side
 *  (`_build_task` in services/aito_quote_import.py never sets it) and is
 *  carried through rather than hand-set — a preview task is never actually
 *  ticked, but there is no reason to assert that here too. */
function toTaskLike(task: AitoTaskCreate): TaskLike {
  return {
    scanCost: task.scan_cost,
    modelisationCost: task.modelisation_cost,
    impressionCost: task.impression_cost,
    usinageCost: task.usinage_cost,
    done: {
      scan: task.scan_done ?? false,
      modelisation: task.modelisation_done ?? false,
      impression: task.impression_done ?? false,
      usinage: task.usinage_done ?? false,
    },
    title: task.title ?? undefined,
    scanDiscountPct: task.scan_discount_pct,
    modelisationDiscountPct: task.modelisation_discount_pct,
    impressionDiscountPct: task.impression_discount_pct,
    usinageDiscountPct: task.usinage_discount_pct,
  };
}

/** Which services a preview task has enabled, in canonical order. */
function servicesOf(task: AitoTaskCreate): string[] {
  const like = toTaskLike(task);
  return SERVICES.filter((service) => taskCost(like, service) !== null);
}

/** What the quote charges for one preview task.
 *
 *  Every service's cost arrives PRE-discount — `_build_task` in
 *  services/aito_quote_import.py adopts each line's percent into its own
 *  `<service>_discount_pct` rather than baking it into the cost, so the two
 *  never double-count. `summariseTasks` (utils/aitoBoardRules.ts) already
 *  applies that same discount rule for all four services, so a single-task
 *  summary gives this preview its total without restating it. */
function taskTotal(task: AitoTaskCreate): number {
  return summariseTasks([toTaskLike(task)]).total;
}

/** Pick a quote, see what it becomes, import it — the import workbench's twin
 *  of `NewProjectDrawer`.
 *
 *  Read-only except for the project description: the tasks shown here are the
 *  exact payload that gets posted, so what the user approves is what is
 *  created. Everything else is editable afterwards in the detail panel.
 *
 *  `QuoteResultList` stays mounted whether or not a quote is selected — it
 *  collapses to a compact card itself — so its search text survives a
 *  round trip through Change, the same "nothing is lost" property
 *  `NewProjectDrawer` gives its own draft. */
export function ImportQuoteDrawer({ onClose, onImport, submitting = false }: ImportQuoteDrawerProps) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState<ZohoEstimateSummary | null>(null);
  const [description, setDescription] = useState('');
  // Which quote's suggestion is currently in the textarea, so re-rendering
  // never overwrites what the user typed.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  // Clicking a disabled Import is what turns silent 'wait' checklist lines
  // into visible 'miss' — same reveal-not-swallow rule as NewProjectDrawer.
  const [revealed, setRevealed] = useState(false);

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
    // Matches the list's prefetch staleTime so a prefetched preview renders without a second GET.
    staleTime: 30_000,
  });
  const preview = previewQuery.data ?? null;

  const configuredCurrency = useCurrency();

  // Seed the description once per quote.
  useEffect(() => {
    if (preview && seededFor !== preview.quote.id) {
      setDescription(preview.suggested_description);
      setSeededFor(preview.quote.id);
    }
  }, [preview, seededFor]);

  // Escape/focus/close-animation triad via the shared hook — see its doc.
  // The guarded focus-on-mount is load-bearing here specifically:
  // `QuoteResultList`'s search input carries its own `autoFocus`, which React
  // applies during commit, before the hook's effect runs, so an unconditional
  // panel focus would steal it back and typing would go nowhere. That guard
  // still covers the Zoho-not-configured branch, which renders no input at
  // all and so never satisfies `contains`.
  const { closing, requestClose, dialogRef: panelRef } = useDismissableDialog(onClose, { animationMs: 220 });

  const currency = preview?.quote.currency_code || configuredCurrency;
  const currencyMismatch = Boolean(preview && preview.quote.currency_code !== configuredCurrency);
  // Plus the freight: `build_line_items` puts the shipping line on the
  // estimate, so `quote.total` counts it and a task-only sum could never
  // agree with the quote on a shipped import — which made the mismatch
  // caption below fire on every one of them.
  const projectTotal =
    (preview?.tasks ?? []).reduce((sum, task) => sum + taskTotal(task), 0) + (preview?.shipping?.price ?? 0);
  const hasTasks = (preview?.tasks.length ?? 0) > 0;
  // A quote already backing an ACTIVE project is a hard block, not a warn:
  // the backend 409s the create anyway (_reject_duplicate_quote), so letting
  // the user finish the flow only moves the refusal to the worst moment.
  // The picker's rows are blocked too (QuoteResultList), but this gate is
  // the one that holds when the board cache is stale. Trashed projects free
  // their quote — the preview's existing_project_id counts active only.
  const alreadyImported = preview !== null && preview.existing_project_id !== null;
  const canImport = Boolean(preview) && hasTasks && !alreadyImported && description.trim().length > 0 && !submitting;

  // The currency-mismatch line renders amber 'miss' for visibility but is
  // NOT part of `canImport` above — that warn never blocks (spec rule);
  // missing service lines, an already-imported quote and an empty
  // description do.
  const checklist: { state: ChecklistState; text: string }[] = [
    {
      state: !preview ? 'wait' : hasTasks ? 'ok' : 'miss',
      text: hasTasks || !preview ? t('aito.ruleQuoteLines') : t('aito.quoteNoServiceLines'),
    },
    {
      state: !preview ? 'wait' : alreadyImported ? 'miss' : 'ok',
      text:
        alreadyImported && preview
          ? t('aito.quoteAlreadyImported', { id: preview.existing_project_id })
          : t('aito.ruleQuoteFresh'),
    },
    {
      state: !preview ? 'wait' : currencyMismatch ? 'miss' : 'ok',
      text:
        currencyMismatch && preview
          ? t('aito.quoteCurrencyMismatch', { code: preview.quote.currency_code, configured: configuredCurrency })
          : t('aito.ruleCurrencyOk'),
    },
    { state: description.trim() ? 'ok' : revealed ? 'miss' : 'wait', text: t('aito.ruleImportDescription') },
  ];

  const submit = () => {
    if (!canImport || !preview) {
      setRevealed(true);
      return;
    }
    onImport({ description: description.trim(), preview });
  };

  return (
    <div
      // pointer-events-none while closing: the drawer is already spoken for,
      // and a click landing under it mid-exit would hit the board.
      className={`fixed inset-0 z-50 bg-black/60 ${closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.importTitle')}
        tabIndex={-1}
        className={`${closing ? 'animate-drawer-out' : 'animate-drawer-in'} fixed inset-y-0 right-0 z-50 flex w-full max-w-[900px] flex-col border-l border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-[-30px_0_60px_rgba(0,0,0,0.5)] focus:outline-none`}
      >
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-bambu-dark-tertiary px-4 py-3">
          <h2 className="text-base font-semibold text-white">{t('aito.importTitle')}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={requestClose}
            className={`-m-1 ml-auto rounded-md p-1 text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_288px]">
          <div className="flex flex-col gap-4 overflow-y-auto border-r border-bambu-dark-tertiary p-4 scrollbar-hide">
            {zohoNotConfigured ? (
              <div>
                <label className={labelCls}>{t('aito.quoteSearchLabel')}</label>
                <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark p-3 text-sm text-bambu-gray">
                  {t('aito.zohoNotConfigured')}{' '}
                  <Link to="/settings?tab=zoho" className="text-bambu-green hover:underline">
                    {t('aito.zohoConfigureLink')}
                  </Link>
                </div>
              </div>
            ) : (
              <QuoteResultList
                selected={selected}
                onSelect={(quote) => setSelected(quote)}
                onClear={() => setSelected(null)}
              />
            )}

            {previewQuery.isError && <p className="text-sm text-status-error">{t('aito.quoteLoadFailed')}</p>}

            {previewQuery.isFetching && !preview && !previewQuery.isError && (
              <div className="space-y-4">
                <div className="animate-pulse space-y-2 border-t border-bambu-dark-tertiary pt-4">
                  <div className="h-4 w-48 rounded bg-bambu-dark-tertiary" />
                  <div className="h-3 w-32 rounded bg-bambu-dark-tertiary/60" />
                </div>
                <div className="animate-pulse space-y-2 rounded-lg border border-bambu-dark-tertiary p-3">
                  <div className="h-3.5 w-full rounded bg-bambu-dark-tertiary" />
                  <div className="h-3.5 w-3/4 rounded bg-bambu-dark-tertiary" />
                </div>
              </div>
            )}

            {preview && (
              <div key={preview.quote.id} className="animate-rise space-y-4">
                <div className="flex items-baseline justify-between gap-2 border-t border-bambu-dark-tertiary pt-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-white">
                      {preview.quote.number} · {preview.client.name}
                    </p>
                    <p className="text-xs text-bambu-gray">
                      {[
                        preview.quote.date ? new Date(preview.quote.date + 'T00:00:00').toLocaleDateString(i18n.language) : '',
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
                    className="flex flex-shrink-0 items-center gap-1 text-xs text-bambu-gray transition-colors hover:text-bambu-green"
                  >
                    <Money currency={currency} value={preview.quote.total} />
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>

                {preview.existing_project_id !== null && (
                  // Error tone, not warning: this line is a hard block now,
                  // same as the no-service-lines one below it.
                  <p className="flex items-center gap-2 text-sm text-status-error">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    {t('aito.quoteAlreadyImported', { id: preview.existing_project_id })}
                  </p>
                )}

                {currencyMismatch && (
                  <p className="text-xs text-bambu-gray">
                    {t('aito.quoteCurrencyMismatch', { code: preview.quote.currency_code, configured: configuredCurrency })}
                  </p>
                )}

                {!hasTasks && (
                  <p className="flex items-center gap-2 text-sm text-status-error">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    {t('aito.quoteNoServiceLines')}
                  </p>
                )}

                <div className="rounded-lg border border-bambu-dark-tertiary">
                  {preview.tasks.map((task, index) => (
                    <div
                      key={index}
                      className="border-b border-bambu-dark-tertiary p-3 last:border-b-0"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm text-white">{task.title || t('aito.taskFallbackName', { n: index + 1 })}</p>
                        <Money currency={currency} value={taskTotal(task)} className="flex-shrink-0 text-xs font-medium text-bambu-green" />
                      </div>
                      <ServiceBadges services={servicesOf(task)} className="mt-1.5" />
                      {(['scan', 'modelisation', 'impression', 'usinage'] as const).map((service) => {
                        const description = task[`${service}_description`];
                        if (!description) return null;
                        return (
                          <p key={service} className="mt-1.5 whitespace-pre-wrap break-words text-xs text-bambu-gray">
                            <span className="text-bambu-gray-light">{t(AITO_SERVICE_LABEL_KEYS[service])} · </span>
                            {description}
                          </p>
                        );
                      })}
                    </div>
                  ))}

                  {preview.skipped_lines.length > 0 && (
                    <div className="space-y-1 border-t border-bambu-dark-tertiary p-3">
                      <p className="text-xs uppercase tracking-wide text-bambu-gray">{t('aito.quoteSkipped')}</p>
                      {preview.skipped_lines.map((line) => (
                        <p key={`${line.sku}-${line.name}`} className="flex justify-between gap-2 text-xs text-bambu-gray">
                          <span className="truncate">{[line.sku, line.name].filter(Boolean).join(' · ')}</span>
                          <Money currency={currency} value={line.amount} className="flex-shrink-0" />
                        </p>
                      ))}
                    </div>
                  )}

                  <div data-testid="import-receipt-totals" className="flex justify-between gap-2 border-t border-bambu-dark-tertiary p-3 text-sm">
                    <span className="font-semibold text-white">{t('aito.projectTotal')}</span>
                    <Money currency={currency} value={projectTotal} className="flex-shrink-0 font-bold text-bambu-green-light" />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4 overflow-y-auto bg-bambu-dark p-4 scrollbar-hide">
            <div>
              <label htmlFor="aito-import-description" className={labelCls}>
                {t('aito.productDescription')}
              </label>
              <textarea
                id="aito-import-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={10000}
                rows={4}
                disabled={!preview}
                className={`${inputCls} resize-none disabled:opacity-40`}
              />
            </div>

            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-bambu-gray-light">{t('aito.importTaskCount', { count: preview?.tasks.length ?? 0 })}</span>
              </div>
              <div className="flex justify-between gap-2 border-t border-bambu-dark-tertiary pt-2">
                <span className="font-semibold text-white">{t('aito.projectTotal')}</span>
                <Money currency={currency} value={projectTotal} className="flex-shrink-0 font-bold text-bambu-green-light" />
              </div>
              {preview && projectTotal !== preview.quote.total && (
                <p data-testid="import-total-mismatch" className="text-xs text-bambu-gray">
                  {t('aito.quoteTotals', {
                    project: projectTotal.toLocaleString(i18n.language),
                    quote: preview.quote.total.toLocaleString(i18n.language),
                  })}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wider text-bambu-gray">{t('aito.beforeImport')}</div>
              {checklist.map((line) => (
                <Line key={line.text} state={line.state} text={line.text} />
              ))}
            </div>

            <button
              type="button"
              // Not `disabled`: a disabled button swallows the click, and the
              // click is what reveals the errors explaining the disabling.
              aria-disabled={!canImport}
              onClick={submit}
              className={`mt-auto inline-flex w-full items-center justify-center gap-2 rounded-md bg-bambu-green px-4 py-2 text-sm font-semibold text-white transition-opacity ${focusRingCls} ${
                canImport ? 'hover:bg-bambu-green-light' : 'opacity-45'
              }`}
            >
              <FileInput className="h-4 w-4" />
              {t('aito.quoteImport')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
