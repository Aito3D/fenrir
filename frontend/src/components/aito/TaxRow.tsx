import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, Lock, Percent } from 'lucide-react';
import { api, ApiError, type AitoProject, type AitoTax } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatMoney } from '../../utils/pricing';
import { settleProject } from './settleProject';

/** The card's Books tax, in the Billing panel: the rate on every quote line, opened in place to pick another one.
 *  Keeping the price before tax rescales every price (a tax-free client pays less); keeping the price the client
 *  pays moves none. "Use for <customer>'s next cards" is the customer account's default, not the contact's. */
export function TaxRow({ project, canUpdate, currency }: { project: AitoProject; canUpdate: boolean; currency: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [keepBeforeTax, setKeepBeforeTax] = useState(true);
  const [remember, setRemember] = useState<boolean | null>(null);
  const taxes = useQuery({
    queryKey: ['aito-taxes', project.client_id ?? null],
    queryFn: () => api.getAitoTaxes(project.client_id),
    enabled: open || !!project.tax_id,
    staleTime: 60_000,
  });
  const save = useMutation({
    mutationFn: (tax: AitoTax) =>
      api.setAitoProjectTax(project.id, { tax_id: tax.tax_id, keep_price_before_tax: keepBeforeTax, remember: rememberOn, expected_version: project.version }),
    onSuccess: (row, tax) => {
      settleProject(queryClient, project.id, row);
      void queryClient.invalidateQueries({ queryKey: ['aito-tasks', project.id] });
      void queryClient.invalidateQueries({ queryKey: ['aito-taxes'] });
      setOpen(false);
      showToast(t('aito.tax.saved', { name: tax.name }), 'success');
    },
    onError: (error) => {
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 409) void queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      showToast(`${t('aito.saveFailed')}${status === 409 || status === 502 ? ` ${(error as ApiError).message}` : ''}`, 'error');
    },
  });

  const money = (n: number) => formatMoney(n, currency);
  const pct = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  const label = project.tax_id ? (project.tax_pct === 0 ? t('aito.tax.free') : pct(project.tax_pct ?? 0)) : t('aito.tax.standard');
  const locked = !!project.quote_invoiced;
  const data = taxes.data;
  const isCustomerDefault = !!project.tax_id && data?.customer_tax_id === project.tax_id;
  const hint = !project.tax_id ? t('aito.tax.defaultHint') : isCustomerDefault ? t('aito.tax.customerDefault', { customer: project.client_name ?? '' }) : t('aito.tax.cardOnly');

  // The current rate and the card total; a new rate keeps either the price before tax or the total.
  const current = data?.taxes.find(x => x.tax_id === (project.tax_id ?? data.default_tax_id));
  const currentPct = project.tax_id ? project.tax_pct ?? 0 : current?.pct ?? 0;
  const total = (project.tasks_total ?? 0) + (project.shipping_price ?? 0);
  const totalWith = (newPct: number) => (keepBeforeTax ? Math.round((total / (1 + currentPct / 100)) * (1 + newPct / 100)) : total);
  const chosen = data?.taxes.find(x => x.tax_id === (picked ?? project.tax_id ?? data.default_tax_id));
  const rememberOn = remember ?? isCustomerDefault;

  const toggle = () => {
    setPicked(null);
    setKeepBeforeTax(true);
    setRemember(null);
    setOpen(o => !o);
  };

  return (
    <div className="py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="text-bambu-gray">{t('aito.tax.label')}</span>
          <span className="block text-xs text-bambu-gray/80">{hint}</span>
        </span>
        <button
          type="button"
          onClick={toggle}
          disabled={!canUpdate || locked}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2.5 py-1 font-semibold text-white hover:border-bambu-green/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Percent aria-hidden="true" className="h-3.5 w-3.5 text-bambu-gray" />
          {label}
          {!locked && <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-bambu-gray" />}
        </button>
      </div>
      {locked && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-400">
          <Lock aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0" />
          {t('aito.tax.locked')}
        </p>
      )}
      {open && !locked && (
        <div role="group" aria-label={t('aito.tax.editor')} className="mt-2 space-y-3 rounded-lg border border-bambu-green/30 bg-bambu-dark p-3 text-xs motion-safe:animate-rise-sm">
          {taxes.isPending ? (
            <div className="flex items-center gap-2 text-bambu-gray"><Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />{t('aito.tax.loading')}</div>
          ) : !data ? (
            <p className="text-amber-400">{t('aito.tax.loadFailed')}</p>
          ) : (
            <>
              <div role="radiogroup" aria-label={t('aito.tax.rate')} className="space-y-1.5">
                {data.taxes.map(tax => {
                  const on = chosen?.tax_id === tax.tax_id;
                  return (
                    <label key={tax.tax_id} className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-2.5 py-2 ${on ? 'border-bambu-green/60 bg-bambu-green/5' : 'border-bambu-dark-tertiary'}`}>
                      <input type="radio" name={`tax-${project.id}`} checked={on} disabled={save.isPending} onChange={() => setPicked(tax.tax_id)} className="accent-bambu-green" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold text-white">{tax.pct === 0 ? t('aito.tax.free') : pct(tax.pct)}</span>
                        <span className="block truncate text-bambu-gray">{tax.name}</span>
                      </span>
                      <span className="tabular-nums text-white">{money(totalWith(tax.pct))}</span>
                    </label>
                  );
                })}
              </div>
              <div className="space-y-1.5">
                <div className="text-[11px] uppercase tracking-wide text-bambu-gray">{t('aito.tax.keep')}</div>
                <div role="group" className="grid grid-cols-2 gap-0.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary p-0.5">
                  {([true, false] as const).map(v => (
                    <button
                      key={String(v)}
                      type="button"
                      aria-pressed={keepBeforeTax === v}
                      onClick={() => setKeepBeforeTax(v)}
                      className={`rounded px-2 py-1.5 ${keepBeforeTax === v ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
                    >
                      {t(v ? 'aito.tax.keepBeforeTax' : 'aito.tax.keepTotal')}
                    </button>
                  ))}
                </div>
                <p className="text-bambu-gray">{t(keepBeforeTax ? 'aito.tax.keepBeforeTaxHint' : 'aito.tax.keepTotalHint')}</p>
              </div>
              {project.client_id && (
                <label className="flex cursor-pointer items-start gap-2">
                  <input type="checkbox" checked={rememberOn} onChange={e => setRemember(e.target.checked)} className="mt-0.5 accent-bambu-green" />
                  <span>
                    <span className="text-white">{t('aito.tax.remember', { customer: project.client_name ?? '' })}</span>
                    <span className="block text-bambu-gray">{t('aito.tax.rememberHint')}</span>
                  </span>
                </label>
              )}
              {chosen && (
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-md border border-bambu-dark-tertiary px-2.5 py-2 tabular-nums">
                  <dt className="text-bambu-gray">{t('aito.tax.beforeTax')}</dt>
                  <dd className="text-right">{money(Math.round(totalWith(chosen.pct) / (1 + chosen.pct / 100)))}</dd>
                  <dt className="text-bambu-gray">{chosen.pct === 0 ? t('aito.tax.label') : chosen.name}</dt>
                  <dd className="text-right">{chosen.pct === 0 ? '—' : money(totalWith(chosen.pct) - Math.round(totalWith(chosen.pct) / (1 + chosen.pct / 100)))}</dd>
                  <dt className="border-t border-bambu-dark-tertiary pt-1 font-semibold text-white">{t('aito.tax.total')}</dt>
                  <dd className="border-t border-bambu-dark-tertiary pt-1 text-right font-semibold text-white">{money(totalWith(chosen.pct))}</dd>
                </dl>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={toggle} disabled={save.isPending} className="rounded-md px-2.5 py-1 text-bambu-gray hover:text-white disabled:opacity-50">
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={!chosen || save.isPending}
                  onClick={() => chosen && save.mutate(chosen)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-3 py-1 font-semibold text-black hover:bg-bambu-green-light disabled:opacity-50"
                >
                  {save.isPending ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}
                  {t(save.isPending ? 'aito.tax.saving' : 'aito.tax.apply')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
