import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, PiggyBank, X } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { CalcInput } from '../CalcInput';
import { api, ApiError, type AitoDepositCredit, type AitoInvoiceDeposits } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { formatMoney } from '../../utils/pricing';
import { depositPrefill } from './depositPrefill';

/** A beat past .animate-modal-out's 150ms — the margin MergeProjectModal gives. */
const MODAL_OUT_MS = 170;

/** Apply one of this quote's unspent deposits to its open invoice.
 *
 *  The caller guarantees `data.invoice` is set and at least one deposit has
 *  money left. The amount starts at whichever runs out first (invoice balance
 *  or deposit) and cannot exceed that; the server re-reads Books and has the
 *  last word: a 409 `amount_too_high` shows its cap, a 502 `outcome_unknown`
 *  says to check the invoice before retrying, and any error re-reads the
 *  figures. Like MergeProjectModal it stacks above the panel (z-[110]) and swallows Escape. */
export function ApplyDepositModal({
  projectId,
  data,
  onClose,
}: {
  projectId: number;
  data: AitoInvoiceDeposits;
  onClose: () => void;
}) {
  // `data` is a live query: a refetch can empty it while the modal is open.
  const gone = !data.invoice || data.deposits.length === 0;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (!data.invoice || gone) return null;
  return <ApplyDepositDialog projectId={projectId} invoice={data.invoice} deposits={data.deposits} onClose={onClose} />;
}

type DepositInvoice = NonNullable<AitoInvoiceDeposits['invoice']>;

const roundCents = (n: number) => Math.round(n * 100) / 100;

function ApplyDepositDialog({
  projectId,
  invoice,
  deposits,
  onClose,
}: {
  projectId: number;
  invoice: DepositInvoice;
  deposits: AitoDepositCredit[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  // Synchronous guard: two clicks in one tick both see isPending === false.
  const inFlight = useRef(false);
  const money = (n: number) => formatMoney(n, invoice.currency_code);

  const [selectedId, setSelectedId] = useState(deposits[0].id);
  const selected = deposits.find((d) => d.id === selectedId) ?? deposits[0];
  const prefill = depositPrefill(invoice.balance, selected.applicable);
  const [amount, setAmount] = useState<number>(prefill.amount);
  const [error, setError] = useState<string | null>(null);
  const cap = prefill.amount;
  const tooHigh = amount > cap + 0.005;
  const valid = amount > 0 && !tooHigh;
  const hint =
    amount === prefill.amount
      ? t(prefill.reason === 'paysInFull' ? 'aito.applyDepositPaysInFull' : 'aito.applyDepositUsesAll')
      : null;

  // The chosen deposit vanished from a refetched list: fall to the first and
  // re-prefill, exactly as `select` does.
  if (selected.id !== selectedId) {
    setSelectedId(selected.id);
    setAmount(prefill.amount);
  }

  const select = (id: string) => {
    const next = deposits.find((d) => d.id === id);
    if (!next) return;
    setSelectedId(id);
    setAmount(depositPrefill(invoice.balance, next.applicable).amount);
    setError(null);
  };

  const applyErrorText = (err: unknown): string => {
    if (!(err instanceof ApiError)) return t('aito.applyDepositError');
    if (err.code === 'outcome_unknown') return t('aito.applyDepositUnknown');
    if (err.code === 'amount_too_high' && typeof err.detail?.cap === 'number') {
      return t('aito.applyDepositTooHigh', { amount: money(err.detail.cap) });
    }
    return err.message || t('aito.applyDepositError');
  };

  const apply = useMutation({
    mutationFn: (amt: number) =>
      api.applyAitoInvoiceDeposit(projectId, { invoice_id: invoice.id, retainer_id: selected.id, amount: amt }),
    onSuccess: (_, amt) => {
      for (const key of ['aito-invoice', 'aito-invoice-deposits', 'aito-retainers', 'aito-events']) {
        queryClient.invalidateQueries({ queryKey: [key, projectId] });
      }
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      showToast(t('aito.applyDepositDone', { amount: money(amt), invoice: invoice.number }), 'success');
      onClose();
    },
    onSettled: () => {
      inFlight.current = false;
    },
    onError: (err) => {
      // Whatever went wrong, the figures in hand may now be stale (the
      // invoice shrank, the deposit was spent, or the apply may have landed):
      // re-read them so the modal shows what Books says now.
      for (const key of ['aito-invoice-deposits', 'aito-invoice', 'aito-events']) {
        queryClient.invalidateQueries({ queryKey: [key, projectId] });
      }
      setError(applyErrorText(err));
    },
  });

  const submit = () => {
    if (inFlight.current || !valid) return;
    inFlight.current = true;
    apply.mutate(amount);
  };
  const guardedClose = () => {
    if (!closing && !apply.isPending && !inFlight.current) requestClose();
  };

  const title = t('aito.applyDepositTitle', { invoice: invoice.number });

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={guardedClose}
      // The panel's window-level Escape listener is still mounted: stop the
      // key here or one Escape closes both.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        guardedClose();
      }}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="apply-deposit-modal"
        tabIndex={-1}
        className={`w-full max-w-[480px] max-h-[88vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-0 flex flex-col min-h-0">
          <header className="grid grid-cols-[36px_1fr_auto] items-center gap-x-3 px-6 pt-5 pb-4">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-[9px] bg-bambu-dark-tertiary text-bambu-gray-light"
            >
              <PiggyBank className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[1.05rem] font-semibold leading-tight text-white truncate">{title}</h2>
              <p className="mt-0.5 text-xs text-bambu-gray leading-snug">{t('aito.applyDepositBody')}</p>
            </div>
            <button
              type="button"
              onClick={guardedClose}
              disabled={apply.isPending}
              aria-label={t('common.close')}
              className={`grid h-8 w-8 place-items-center rounded-md text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide px-6 pb-4 space-y-4">
            <div role="radiogroup" aria-label={title} className="space-y-1.5">
              {deposits.map((d) => (
                <label
                  key={d.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm has-[:checked]:border-bambu-green/50"
                >
                  <input
                    type="radio"
                    name="deposit"
                    checked={d.id === selected.id}
                    onChange={() => select(d.id)}
                    className="accent-bambu-green"
                  />
                  <span className="min-w-0 flex-1 truncate text-white">{d.number}</span>
                  <span className="flex-none text-xs text-bambu-gray">
                    {t('aito.applyDepositAvailable', { amount: money(d.applicable) })}
                  </span>
                </label>
              ))}
            </div>

            <div>
              <label htmlFor="apply-deposit-amount" className="mb-1 block text-xs text-bambu-gray">
                {t('aito.applyDepositAmount')}
              </label>
              <CalcInput
                id="apply-deposit-amount"
                value={amount}
                onValueChange={(raw) => {
                  const n = Number(raw);
                  setAmount(Number.isFinite(n) ? roundCents(n) : 0);
                  setError(null);
                }}
                className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-sm text-white focus:border-bambu-green/50 focus:outline-none"
              />
              {tooHigh ? (
                <p className="mt-1 text-xs text-red-400">{t('aito.applyDepositTooHigh', { amount: money(cap) })}</p>
              ) : hint ? (
                <p className="mt-1 text-xs text-bambu-gray">{hint}</p>
              ) : null}
            </div>
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3">
            <p role="alert" className="min-w-0 break-words text-xs text-red-400">
              {error}
            </p>
            <div className="flex flex-none items-center gap-2">
              <Button variant="secondary" size="sm" onClick={requestClose} disabled={apply.isPending}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" disabled={!valid || apply.isPending} onClick={submit}>
                {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {t('aito.applyDepositConfirm', { amount: money(amount) })}
              </Button>
            </div>
          </footer>
        </CardContent>
      </Card>
    </div>
  );
}
