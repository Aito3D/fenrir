import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import type { AitoProject, CalculatorFilament, CalculatorPrinter } from '../../api/client';
import type { TaskDraft } from '../../utils/taskDraft';
import { parseLocalDateKey, parseUTCDate } from '../../utils/date';
import { AITO_SERVICE_LABEL_KEYS, taskSteps, type ServiceId } from './services';

export interface JobTicketProps {
  project: AitoProject;
  tasks: TaskDraft[];
  printers: CalculatorPrinter[];
  filaments: CalculatorFilament[];
  trackingUrl: string | null;
  /** Username for the footer; '' when auth is off, and the footer then
   *  carries the date alone. */
  printedBy: string;
  now: Date;
}

const DESCRIPTION_KEYS: Record<ServiceId, keyof TaskDraft> = {
  scan: 'scanDescription',
  modelisation: 'modelisationDescription',
  impression: 'impressionDescription',
  usinage: 'usinageDescription',
  maindoeuvre: 'maindoeuvreDescription',
};

const QUANTITY_KEYS: Partial<Record<ServiceId, keyof TaskDraft>> = {
  scan: 'scanQuantity',
  modelisation: 'modelisationQuantity',
  usinage: 'usinageQuantity',
};

/** The paper that travels with the job through the shop (spec A6): who it is
 *  for, when it is promised, and one tick box per step still to be worked.
 *
 *  Deliberately carries NO money — it is pinned beside the printer and seen
 *  by whoever walks past, the client included. Only the steps the task
 *  actually has are listed (`taskSteps`, the same null-cost membership rule
 *  the step list and the board use), so a box never asks for work that was
 *  not quoted.
 *
 *  A plain view with class names only: `buildJobTicketHtml` renders it to
 *  static markup for a hidden iframe, where the app's stylesheet does not
 *  exist and the print CSS beside it is the only styling. */
export function JobTicket({ project, tasks, printers, filaments, trackingUrl, printedBy, now }: JobTicketProps) {
  const { t, i18n } = useTranslation();
  const day = (d: Date | null) => (d ? d.toLocaleDateString(i18n.language, { dateStyle: 'medium' }) : '—');
  const stamp = now.toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const printerName = (id: number | null) => printers.find((p) => p.id === id)?.name ?? null;
  const filamentName = (id: number | null) => filaments.find((f) => f.id === id)?.name ?? null;

  const details = (task: TaskDraft, service: ServiceId): string[] => {
    if (service === 'impression') {
      const { printerId, filamentId, color, quantity, weightG, timeMin } = task.impression;
      const filament = [filamentName(filamentId), color.trim()].filter(Boolean).join(' · ');
      return [
        printerName(printerId),
        filament,
        t('aito.jobTicketQuantity', { qty: quantity }),
        weightG !== null ? t('aito.jobTicketWeight', { grams: weightG }) : null,
        timeMin !== null ? t('aito.jobTicketTime', { minutes: timeMin }) : null,
      ].filter((part): part is string => Boolean(part));
    }
    const key = QUANTITY_KEYS[service];
    return key ? [t('aito.jobTicketQuantity', { qty: task[key] as number })] : [];
  };

  return (
    <div className="ticket">
      <header className="head" data-testid="job-ticket-header">
        <div className="head-main">
          <div className="eyebrow">{t('aito.jobTicketTitle')}</div>
          <div className="ids">
            <span className="card-no">#{project.id}</span>
            {project.quote_number && <span className="quote-no">{project.quote_number}</span>}
          </div>
          <div className="client">{project.client_name ?? t('aito.noClient')}</div>
          {project.client_phone && <div className="phone">{project.client_phone}</div>}
          <dl className="dates">
            <div>
              <dt>{t('aito.jobTicketPromised')}</dt>
              <dd>{day(project.due_date ? parseLocalDateKey(project.due_date) : null)}</dd>
            </div>
            <div>
              <dt>{t('aito.jobTicketCreated')}</dt>
              <dd>{day(parseUTCDate(project.created_at))}</dd>
            </div>
          </dl>
        </div>
        {trackingUrl && (
          <div className="qr" data-testid="job-ticket-qr">
            <QRCodeSVG value={trackingUrl} size={112} level="M" marginSize={0} />
          </div>
        )}
      </header>

      {project.description.trim() && <p className="description">{project.description}</p>}

      {tasks.map((task) => (
        <section key={task.id ?? task.uid} className="task" data-testid="job-ticket-task">
          <h2 className="task-title">{task.title.trim() || '—'}</h2>
          <ul className="steps">
            {taskSteps(task).map(({ service }) => {
              const note = String(task[DESCRIPTION_KEYS[service]] ?? '').trim();
              const parts = details(task, service);
              return (
                <li key={service} className="step" data-testid="job-ticket-step" data-service={service}>
                  <div className="step-row">
                    <span className="tick" data-testid="job-ticket-tick" aria-hidden="true" />
                    <span className="step-name">{t(AITO_SERVICE_LABEL_KEYS[service])}</span>
                    {parts.length > 0 && <span className="step-details">{parts.join(' — ')}</span>}
                  </div>
                  {note && <div className="step-note">{note}</div>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <footer className="foot" data-testid="job-ticket-footer">
        {printedBy
          ? t('aito.jobTicketPrintedBy', { date: stamp, user: printedBy })
          : t('aito.jobTicketPrinted', { date: stamp })}
      </footer>
    </div>
  );
}
