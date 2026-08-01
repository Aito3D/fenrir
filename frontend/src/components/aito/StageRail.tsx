import { useTranslation } from 'react-i18next';
import { ALL_COLUMNS } from './columns';
import { stagesWithWork } from './services';
import { Money } from '../calculator/shared';
import { formatMoney } from '../../utils/pricing';
import type { AitoColumnId } from '../../api/client';
import type { TaskDraft } from '../../utils/taskDraft';

export interface StageRailProps {
  tasks: readonly TaskDraft[];
  /** The project's CURRENT column, as derived by the rule engine. */
  column: AitoColumnId;
  currency: string;
}

/** Where the project has got to, and what each stage still owes.
 *
 *  READ-ONLY BY CONSTRUCTION — no button, no handler, no mutation. A column is
 *  derived by the board rule engine (`evaluate` in utils/aitoBoardRules.ts) from
 *  the quote status and the services with unticked steps; the only manual
 *  transition in the whole model is Finish <-> Done, and that lives on the card.
 *  A pressable stage here would have to either no-op or fight the engine.
 *
 *  It replaces a 2px dot at the foot of a spec sheet, and it answers a question
 *  no surface answered before: not just where the card is, but what has to
 *  happen before it moves. */
export function StageRail({ tasks, column, currency }: StageRailProps) {
  const { t } = useTranslation();
  const work = stagesWithWork(tasks);
  const currentIndex = ALL_COLUMNS.findIndex((c) => c.id === column);

  return (
    <div>
      <ol>
        {ALL_COLUMNS.map((meta, index) => {
          const stage = work.find((w) => w.column === meta.id);
          const state = index < currentIndex ? 'past' : index === currentIndex ? 'current' : 'future';
          const percent = stage && stage.stepsTotal > 0 ? (stage.stepsDone / stage.stepsTotal) * 100 : 0;

          return (
            <li
              key={meta.id}
              data-testid={`stage-node-${meta.id}`}
              data-state={state}
              className="relative grid grid-cols-[0.75rem_minmax(0,1fr)] gap-2.5 pb-3 last:pb-0"
            >
              {/* The connector runs from this node to the next. `past` is the
                  travelled path and takes the accent; everything ahead stays
                  the neutral track colour. Hidden on the last row, which has
                  nothing below it to connect to. */}
              <span
                aria-hidden="true"
                className={`absolute left-[0.28rem] top-4 bottom-0 w-0.5 ${
                  state === 'past' ? 'bg-bambu-green' : 'bg-bambu-dark-tertiary'
                } ${index === ALL_COLUMNS.length - 1 ? 'hidden' : ''}`}
              />
              <span
                aria-hidden="true"
                className={`mt-1.5 w-2.5 h-2.5 rounded-full transition-transform duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                  state === 'future' ? 'bg-bambu-dark-tertiary' : state === 'past' ? 'bg-bambu-green' : `${meta.dot} scale-125`
                }`}
              />
              <span className="min-w-0">
                <span
                  className={`text-sm block ${
                    state === 'current' ? 'text-white font-medium' : state === 'past' ? 'text-bambu-gray-light' : 'text-bambu-gray'
                  }`}
                >
                  {t(meta.labelKey)}
                </span>
                {stage && (
                  <span className="flex items-center gap-1.5 mt-1">
                    <span
                      role="progressbar"
                      aria-valuenow={stage.stepsDone}
                      aria-valuemin={0}
                      aria-valuemax={stage.stepsTotal}
                      // formatMoney, not the raw number: the <Money> caption right
                      // beside this bar uses formatMoney too, and a screen reader
                      // announcing "10000 left" next to a sighted "10 000 FCFP left"
                      // would disagree about the figure. Same fix as ValueRing's.
                      aria-label={t('aito.workLeftAtStage', {
                        amount: formatMoney(stage.value - stage.valueDone, currency),
                        stage: t(meta.labelKey),
                      })}
                      className="flex-1 h-0.5 rounded-full bg-bambu-dark-tertiary overflow-hidden"
                    >
                      <span
                        data-testid={`stage-bar-${meta.id}`}
                        style={{ width: `${percent}%` }}
                        className={`block h-full rounded-full ${meta.dot} transition-[width] duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none`}
                      />
                    </span>
                    <Money
                      currency={currency}
                      value={stage.value - stage.valueDone}
                      className="text-xs text-bambu-gray flex-shrink-0"
                    />
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>

    </div>
  );
}
