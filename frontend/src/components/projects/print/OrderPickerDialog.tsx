import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectOrderTask } from '../../../api/client';
import { Button } from '../../Button';
import { useIsolatedEscape } from '../../../hooks/useIsolatedEscape';

/** "none" = internal/test print (no task). */
type Choice = number | 'none' | null;

interface Props {
  /** The project's open orders (not `done`), one row per linked task. */
  orders: ProjectOrderTask[];
  /** The orders could not be loaded: say so; only "None" is offered. */
  unavailable?: boolean;
  /** The orders are still loading: a busy shell, nothing to pick yet. */
  loading?: boolean;
  onConfirm: (taskId: number | null) => void;
  onCancel: () => void;
}

/** Which order a revision print is for: each open order's task, plus "None".
 *  A single open order comes preselected (also when it arrives after a busy
 *  shell); confirming is still one click. */
export function OrderPickerDialog({ orders, unavailable = false, loading = false, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  // undefined = nothing picked yet, so the preselection follows `orders`.
  const [picked, setChoice] = useState<Choice | undefined>(undefined);
  const choice: Choice = loading ? null : picked !== undefined ? picked : orders.length === 1 ? orders[0].task_id : null;
  const dialogRef = useRef<HTMLFormElement>(null);
  // Escape closes this picker only, never the page or a host panel under it.
  useIsolatedEscape(onCancel, dialogRef);
  const title = t('projectsPdm.print.forWhichOrder');

  const rowCls =
    'flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border border-bambu-dark-tertiary px-3 py-2 text-sm text-white hover:bg-bambu-dark-tertiary has-[:checked]:border-bambu-green/60';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 animate-overlay-in" onClick={onCancel}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (choice !== null) onConfirm(choice === 'none' ? null : choice);
        }}
        className="w-full max-w-lg space-y-4 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none"
      >
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        {unavailable && (
          <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
            {t('projectsPdm.print.ordersUnavailable')}
          </p>
        )}
        {loading ? (
          <p role="status" className="flex min-h-[44px] items-center gap-2 px-3 text-sm text-bambu-gray-light">
            <Loader2 className="h-4 w-4 animate-spin text-bambu-green" aria-hidden="true" />
            {t('common.loading')}
          </p>
        ) : (
          <fieldset className="max-h-[50vh] space-y-2 overflow-y-auto">
            <legend className="sr-only">{title}</legend>
            {orders.map((o) => (
              <label key={o.task_id} className={rowCls}>
                <input
                  type="radio"
                  name="print-order"
                  checked={choice === o.task_id}
                  onChange={() => setChoice(o.task_id)}
                  className="accent-bambu-green"
                />
                <span className="min-w-0 break-words">
                  {[t('projectsPdm.aito.orderLabel', { id: o.order_id }), o.client_name, o.task_title || o.order_description]
                    .filter(Boolean)
                    .join(' — ')}
                </span>
              </label>
            ))}
            <label className={rowCls}>
              <input
                type="radio"
                name="print-order"
                checked={choice === 'none'}
                onChange={() => setChoice('none')}
                className="accent-bambu-green"
              />
              <span className="text-bambu-gray-light">{t('projectsPdm.print.noOrder')}</span>
            </label>
          </fieldset>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={choice === null}>
            {t('common.confirm')}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
