import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

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
}

function Line({ state, text }: { state: ChecklistState; text: string }) {
  return (
    <div
      data-state={state}
      className={`flex items-center gap-2 text-xs ${
        state === 'ok' ? 'text-bambu-gray opacity-70' : state === 'miss' ? 'text-amber-400' : 'text-bambu-gray'
      }`}
    >
      <span
        className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border ${
          state === 'ok'
            ? 'border-bambu-green bg-bambu-green text-white'
            : state === 'miss'
              ? 'border-amber-400'
              : 'border-bambu-dark-tertiary'
        }`}
      >
        {state === 'ok' && <Check className="h-2.5 w-2.5" />}
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
  } = props;

  const subTask: { state: ChecklistState; text: string } =
    taskCount === 0
      ? { state: 'wait', text: t('aito.ruleSubTasksPending') }
      : !hasUnpriced
        ? { state: 'ok', text: t('aito.ruleSubTasksOk') }
        : revealedUnpricedName !== null
          ? { state: 'miss', text: t('aito.ruleSubTaskMissing', { name: revealedUnpricedName }) }
          : { state: 'wait', text: t('aito.ruleSubTasksPending') };

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
    </div>
  );
}
