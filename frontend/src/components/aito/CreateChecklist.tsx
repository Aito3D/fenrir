import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { visibleShippingDraftErrors, isShippingComplete } from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';

export type ChecklistState = 'ok' | 'miss' | 'wait';

export interface CreateChecklistProps {
  taskCount: number;
  /** Name of the first unpriced task whose card the user has LEFT (blur-revealed), or null. */
  revealedUnpricedName: string | null;
  /** True when at least one unpriced task exists (drives ok vs wait/miss). */
  hasUnpriced: boolean;
  summaryState: 'waiting' | 'generating' | 'ready';
  clientAccountName: string;
  clientReachable: boolean;
  /** Contact channel shown when reachable (phone or email). */
  clientContact: string;
  /** True once the client fields have been blurred (or a submit attempt happened). */
  clientRevealed: boolean;
  /** null when no shipment exists — the line is absent entirely, not just empty. */
  shipping: ShippingDraft | null;
  /** The chosen island's display label, passed in from the drawer (which
   *  already has the services list) — this component must never fetch. */
  shippingIslandLabel: string;
}

/** Shared checklist row (box, `animate-tick-in` tick, 300ms colour transition) consumed by `CreateChecklist` and `ImportQuoteDrawer`. */
export function Line({ state, text }: { state: ChecklistState; text: string }) {
  return (
    <div
      data-state={state}
      // duration-300, same as the drawer section badge's colour transition, so
      // a requirement being satisfied reads as one settling gesture wherever
      // it is acknowledged.
      className={`flex items-center gap-2 text-xs transition-colors duration-300 motion-reduce:transition-none ${
        state === 'ok' ? 'text-bambu-gray opacity-70' : state === 'miss' ? 'text-amber-400' : 'text-bambu-gray'
      }`}
    >
      <span
        className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border transition-colors duration-300 motion-reduce:transition-none ${
          state === 'ok'
            ? 'border-bambu-green bg-bambu-green text-white'
            : state === 'miss'
              ? 'border-amber-400'
              : 'border-bambu-dark-tertiary'
        }`}
      >
        {state === 'ok' && <Check className="h-2.5 w-2.5 animate-tick-in" />}
      </span>
      <span>{text}</span>
    </div>
  );
}

export function CreateChecklist(props: CreateChecklistProps) {
  const { t } = useTranslation();
  const {
    taskCount,
    revealedUnpricedName,
    hasUnpriced,
    summaryState,
    clientAccountName,
    clientReachable,
    clientContact,
    clientRevealed,
    shipping,
    shippingIslandLabel,
  } = props;

  const subTask: { state: ChecklistState; text: string } =
    taskCount === 0
      ? { state: 'wait', text: t('aito.ruleSubTasksPending') }
      : !hasUnpriced
        ? { state: 'ok', text: t('aito.ruleSubTasksOk') }
        : revealedUnpricedName !== null
          ? { state: 'miss', text: t('aito.ruleSubTaskMissing', { name: revealedUnpricedName }) }
          : { state: 'wait', text: t('aito.ruleSubTasksPending') };

  // Rendered only when a shipment exists — a row on the 95% of projects that
  // never ship anything would be noise, not information. The `miss` branch
  // names the first offender, same discipline as the sub-task line above, and
  // it only fires once the field has been LEFT (visibleShippingDraftErrors),
  // so nothing goes amber under the user's cursor.
  const shippingLine: { state: ChecklistState; text: string } = (() => {
    if (!shipping) return { state: 'wait', text: '' };
    const visible = visibleShippingDraftErrors(shipping);
    if (isShippingComplete(shipping)) {
      return {
        state: 'ok',
        text: t('aito.ruleShippingOk', {
          island: shippingIslandLabel,
          recipient: `${shipping.firstName} ${shipping.lastName}`.trim(),
        }),
      };
    }
    const firstError = visible.island ?? visible.firstName ?? visible.lastName ?? visible.phone;
    return firstError ? { state: 'miss', text: t(firstError) } : { state: 'wait', text: t('aito.ruleShippingPending') };
  })();

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-bold uppercase tracking-wider text-bambu-gray">{t('aito.beforeCreate')}</div>
      <Line
        state={taskCount === 0 ? 'miss' : 'ok'}
        text={taskCount === 0 ? t('aito.ruleNeedTask') : t('aito.ruleTasksOk', { count: taskCount })}
      />
      <Line state={subTask.state} text={subTask.text} />
      <Line
        state={summaryState === 'ready' ? 'ok' : 'wait'}
        text={summaryState === 'ready' ? t('aito.summaryTitle') : t('aito.summaryWaiting')}
      />
      <Line state="ok" text={t('aito.ruleClientAccount', { name: clientAccountName })} />
      <Line
        state={clientReachable ? 'ok' : clientRevealed ? 'miss' : 'wait'}
        text={clientReachable ? t('aito.ruleClientReachable', { contact: clientContact }) : t('aito.ruleClientContact')}
      />
      {shipping !== null && <Line state={shippingLine.state} text={shippingLine.text} />}
    </div>
  );
}
