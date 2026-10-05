import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Box, Check, Layers, Palette } from 'lucide-react';
import { AITO_SERVICE_LABEL_KEYS, serviceDotCls, taskSteps } from './services';
import type { ServiceId } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import { api } from '../../api/client';
import type { RevisionStatus, SectionRevisionSummary } from '../../api/client';
import type { TaskDraft } from '../../utils/taskDraft';
import { STATUS_LABEL_KEYS } from '../projects/files/filesUi';
import { PrintedCount } from '../projects/print/PrintedCount';
import type { PrintCounts } from '../projects/print/PrintedCount';

const DESCRIPTION_FIELD = {
  scan: 'scanDescription',
  modelisation: 'modelisationDescription',
  impression: 'impressionDescription',
  usinage: 'usinageDescription',
  maindoeuvre: 'maindoeuvreDescription',
} as const;

/** Only the services that HAVE a unit count. Printing keeps its own inside
 *  `impression`, and labour has none at all — one unit at one price. */
const QUANTITY_FIELD: Record<'scan' | 'modelisation' | 'usinage', 'scanQuantity' | 'modelisationQuantity' | 'usinageQuantity'> = {
  scan: 'scanQuantity',
  modelisation: 'modelisationQuantity',
  usinage: 'usinageQuantity',
};

export interface TaskStepListProps {
  task: TaskDraft;
  onChange: (next: TaskDraft) => void;
  /** Whether the steps may be ticked at all — true only on a project whose
   *  quote is accepted. False renders name and cost with NO toggle rather than
   *  a disabled one: before acceptance there is no authorised work to tick, so
   *  there is nothing for an inert control to explain. A step already ticked
   *  still renders as ticked, because that is stored history. */
  canTick: boolean;
  /** The linked project's newest revisions per section, keyed by the service
   *  that owns the section. A step with a non-empty entry gets one muted line
   *  under its description (`Support R3 · Approved`). Absent = no lines. */
  sectionSummaries?: Partial<Record<ServiceId, SectionRevisionSummary[]>>;
  /** The linked project's print counts for this task (spec §4.2), shown on
   *  the Impression step. Reaching the target only SUGGESTS ticking the step
   *  — through the same toggle a manual tick uses. Absent = no line. */
  printCounts?: PrintCounts;
}

/** A task's steps, read-only apart from their Done toggles.
 *
 *  Only steps that EXIST are listed — a service with no cost is absent from
 *  the job and appears solely in edit mode, where typing a cost is what
 *  creates it. A step quoted at 0 is listed like any other: free is not
 *  absent.
 *
 *  Done is a one-click toggle both ways, deliberately without the
 *  hold-to-confirm the destructive controls use. Un-ticking is the undo, and
 *  an undo that is expensive is an undo nobody reaches for.
 *
 *  The toggle exists at all only when `canTick` — see that prop. The steps
 *  themselves always render, ticks included: what a project's quote is now
 *  does not unsay work that was done. */
export function TaskStepList({ task, onChange, canTick, sectionSummaries, printCounts }: TaskStepListProps) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const steps = taskSteps(task);

  // The material's NAME is the one part of the printing meta that isn't on the
  // task — the task stores `filamentId` and the name lives in the calculator's
  // filament list. Same query key as ImpressionFields/CalculatorPage, so every
  // task row on the panel shares one cached request rather than issuing its own.
  //
  // Gated so that read mode stays as query-free as TaskRow's doc claims for any
  // task that couldn't use the answer: no printing step, or no filament picked.
  // A user without `calculator:read` gets a 403, the list stays empty and the
  // material simply doesn't render — the same degradation an install with no
  // calculator configured already gets. Quantity and colour are unaffected.
  const needsFilamentName = task.impressionCost !== null && task.impression.filamentId !== null;
  const { data: filaments } = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    enabled: needsFilamentName,
    retry: false,
    staleTime: 60_000,
  });

  // material/color stay computed HERE, at component level, rather than inside
  // metaFor below: both depend on the filament query (material) or a task
  // field that only printing has (color), and moving either into a function
  // called once per step would still leave them evaluated once overall — but
  // would make that misleading, since they'd read as per-service values.
  const material = needsFilamentName
    ? (filaments?.find((f) => f.id === task.impression.filamentId)?.name ?? '')
    : '';
  const color = task.impression.color.trim();

  // Each entry is [icon, accessible field name, value]. Absent values are left
  // out entirely rather than rendered blank.
  //
  // Printing is the exception that always states its count, ×1 included: its
  // line also carries material and colour, so ×1 there is one answer among
  // several rather than a lone restatement of the default. The other three
  // services state a count only from 2 up — a bare "×1" under a scan step
  // would be the whole line, and it would say nothing the reader did not
  // already assume. 0 is hidden everywhere: that is not a job.
  const metaFor = (service: ServiceId): { key: string; icon: typeof Layers; label: string; value: string }[] => {
    if (service !== 'impression') {
      // Labour has no count to state — one unit at one price.
      if (service === 'maindoeuvre') return [];
      const quantity = task[QUANTITY_FIELD[service]];
      return quantity >= 2
        ? [{ key: 'quantity', icon: Layers, label: t('aito.quantity'), value: `×${quantity}` }]
        : [];
    }
    const meta: { key: string; icon: typeof Layers; label: string; value: string }[] = [];
    if (task.impression.quantity >= 1) {
      meta.push({ key: 'quantity', icon: Layers, label: t('aito.quantity'), value: `×${task.impression.quantity}` });
    }
    if (material !== '') {
      meta.push({ key: 'material', icon: Box, label: t('aito.material'), value: material });
    }
    if (color !== '') {
      meta.push({ key: 'color', icon: Palette, label: t('aito.color'), value: color });
    }
    return meta;
  };

  // The one tick path: the step's own toggle and the print-target suggestion.
  const toggleStep = (service: ServiceId, done: boolean) => onChange({ ...task, done: { ...task.done, [service]: !done } });

  if (steps.length === 0) {
    return <p className="text-sm text-bambu-gray">{t('aito.noSteps')}</p>;
  }

  return (
    <ul className="space-y-0.5">
      {steps.map(({ service, cost, done }) => {
        const label = t(AITO_SERVICE_LABEL_KEYS[service]);
        const description = task[DESCRIPTION_FIELD[service]].trim();
        const meta = metaFor(service);
        const files = (sectionSummaries?.[service] ?? [])
          .map((s) => `${s.item_name} R${s.number} · ${t(STATUS_LABEL_KEYS[s.status as RevisionStatus] ?? s.status)}`)
          .join(' · ');
        const row = (
          <>
            {/* The checkbox IS the affordance now. The old design put a "Done"
                pill at the end of the row, which named the action but gave it
                the smallest target in the panel. */}
            {canTick && (
              <span
                aria-hidden="true"
                className={`w-4 h-4 flex-shrink-0 rounded grid place-items-center border transition-colors duration-200 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                  done
                    ? 'bg-bambu-green border-bambu-green text-bambu-dark'
                    : 'border-bambu-dark-tertiary text-transparent group-hover/step:border-bambu-green'
                }`}
              >
                {done && <Check className="w-3 h-3 animate-tick-in" />}
              </span>
            )}
            <span
              data-testid={`step-swatch-${service}`}
              aria-hidden="true"
              className={`w-0.5 h-4 flex-shrink-0 rounded-full ${serviceDotCls(service)} transition-opacity duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'opacity-30' : ''
              }`}
            />
            <span
              className={`text-sm flex-1 min-w-0 truncate text-left transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'text-bambu-gray' : 'text-white'
              }`}
            >
              {label}
            </span>
            <Money
              currency={currency}
              value={cost}
              className={`text-sm flex-shrink-0 transition-colors duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none ${
                done ? 'text-bambu-gray' : 'text-white'
              }`}
            />
          </>
        );

        return (
          <li key={service}>
            {canTick ? (
              <button
                type="button"
                aria-pressed={done}
                onClick={() => toggleStep(service, done)}
                // hover uses bambu-dark-tertiary/40, NOT a white alpha: a white
                // overlay on a white card is invisible in light mode. Same
                // token the description's hover already uses in this panel.
                className={`group/step w-full flex items-center gap-3 rounded-md px-1.5 py-1 -mx-1.5 transition-colors motion-reduce:transition-none hover:bg-bambu-dark-tertiary/40 ${focusRingCls}`}
              >
                {row}
              </button>
            ) : (
              // No toggle at all before the quote is accepted — there is no
              // authorised work to tick, so an inert control would explain
              // nothing. The step and its price still render.
              <span className="w-full flex items-center gap-3 px-1.5 py-1 -mx-1.5">{row}</span>
            )}
            {/* The part's physical identity, on its own line under the step:
                quantity always, plus material and colour under printing only.
                Icon + value rather than pills — the panel's whole visual
                argument is restraint, and this line must never outweigh the
                step it describes. Shares the description's gutter exactly (see
                its comment below), so both sub-lines start under the step
                label in either canTick state. */}
            {meta.length > 0 && (
              <p
                data-testid={`step-meta-${service}`}
                className="flex items-start gap-3 pr-1.5 pb-1 text-xs text-bambu-gray-light"
              >
                {canTick && <span aria-hidden="true" className="w-4 flex-shrink-0" />}
                <span aria-hidden="true" className="w-0.5 flex-shrink-0" />
                <span className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  {meta.map(({ key, icon: Icon, label, value }) => (
                    // The icon is decoration; the field name is carried as
                    // sr-only text so the line doesn't read as a bare string of
                    // values, and as a title for pointer users.
                    <span key={key} className="inline-flex min-w-0 items-center gap-1" title={label}>
                      <Icon aria-hidden="true" className="w-3 h-3 flex-shrink-0 opacity-60" />
                      <span className="sr-only">{label}: </span>
                      <span className="truncate tabular-nums">{value}</span>
                    </span>
                  ))}
                </span>
              </p>
            )}
            {description !== '' && (
              <p
                data-testid={`step-desc-${service}`}
                className="flex items-start gap-3 pr-1.5 pb-1 text-xs text-bambu-gray"
              >
                {/* Invisible spacers mirroring the row's own gutter — the
                    checkbox (only when canTick) then the swatch dot, each
                    separated by the same gap-3 the row itself uses — so the
                    text lines up under the step label in BOTH canTick
                    states. A single fixed pl-* can't do that: the checkbox
                    is conditionally rendered, so the gutter width differs by
                    state (42px vs 14px), not just a constant offset. */}
                {canTick && <span aria-hidden="true" className="w-4 flex-shrink-0" />}
                <span aria-hidden="true" className="w-0.5 flex-shrink-0" />
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{description}</span>
              </p>
            )}
            {files !== '' && (
              <p
                data-testid={`step-files-${service}`}
                className="flex items-start gap-3 pr-1.5 pb-1 text-xs text-bambu-gray"
              >
                {/* Same gutter spacers as the description above. */}
                {canTick && <span aria-hidden="true" className="w-4 flex-shrink-0" />}
                <span aria-hidden="true" className="w-0.5 flex-shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={files}>
                  {files}
                </span>
              </p>
            )}
            {service === 'impression' && printCounts && (printCounts.printed > 0 || printCounts.rejected > 0 || printCounts.queued > 0) && (
              <p
                data-testid="step-prints-impression"
                className="flex items-start gap-3 pr-1.5 pb-1 text-xs text-bambu-gray-light"
              >
                {/* Same gutter spacers as the description above. */}
                {canTick && <span aria-hidden="true" className="w-4 flex-shrink-0" />}
                <span aria-hidden="true" className="w-0.5 flex-shrink-0" />
                <span className="min-w-0 flex-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <PrintedCount {...printCounts} />
                  {canTick && !done && printCounts.target !== null && printCounts.printed >= printCounts.target && (
                    <span className="inline-flex items-center gap-1.5 text-bambu-green">
                      <span>{t('projectsPdm.print.tickSuggestion')}</span>
                      <button
                        type="button"
                        onClick={() => toggleStep(service, done)}
                        className={`rounded-md border border-bambu-green/40 px-1.5 py-0.5 font-medium hover:bg-bambu-green/10 ${focusRingCls}`}
                      >
                        {t('projectsPdm.print.tickStep')}
                      </button>
                    </span>
                  )}
                </span>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
