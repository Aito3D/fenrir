import { useState } from 'react';
import { Archive, Plus, StickyNote, Target, Trash2, Wrench, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { HourEvent } from '../../../api/client';
import { isoDayFormatter } from '../../../utils/hoursSeries';
import { Button } from '../../Button';
import { focusRingCls, inputCls } from '../../formStyles';

const KIND_ICON: Record<HourEvent['kind'], LucideIcon> = {
  note: StickyNote,
  maintenance: Wrench,
  added: Plus,
  retired: Archive,
  calibrated: Target,
};

interface MachineEventsProps {
  events: HourEvent[];
  today: string;
  canEdit: boolean;
  onAdd: (body: { event_date: string; label: string }) => void;
  onDelete: (id: number) => void;
}

/** A machine's events, newest first, with an add-a-note row for editors. */
export function MachineEvents({ events, today, canEdit, onAdd, onDelete }: MachineEventsProps) {
  const { t, i18n } = useTranslation();
  const [date, setDate] = useState(today);
  const [text, setText] = useState('');
  const dayFmt = isoDayFormatter(i18n.language);
  const sorted = [...events].sort((a, b) => b.event_date.localeCompare(a.event_date) || b.id - a.id);

  const submit = () => {
    const label = text.trim();
    if (!label || !date) return;
    onAdd({ event_date: date, label });
    setText('');
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-white">{t('maintenance.hours.panel.events')}</h3>
      <ul className="flex flex-col gap-1">
        {sorted.map((ev) => {
          const Icon = KIND_ICON[ev.kind];
          return (
            <li key={ev.id} className="flex items-center gap-2 text-sm">
              <Icon className="h-3.5 w-3.5 shrink-0 text-bambu-gray" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words text-white">{ev.label}</span>
              <span className="shrink-0 text-xs text-bambu-gray">{dayFmt(ev.event_date)}</span>
              {canEdit && ev.kind === 'note' && (
                <button
                  type="button"
                  aria-label={t('maintenance.hours.panel.deleteNote')}
                  onClick={() => onDelete(ev.id)}
                  className={`rounded p-1 text-bambu-gray hover:text-red-400 ${focusRingCls}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <form
          className="flex flex-col gap-2 border-t border-bambu-dark-tertiary pt-2"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <span className="text-xs text-bambu-gray">{t('maintenance.hours.panel.addNote')}</span>
          <div className="flex flex-wrap gap-2">
            <input
              type="date"
              max={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label={t('maintenance.hours.panel.noteDate')}
              className={`${inputCls} !w-auto`}
            />
            <input
              type="text"
              maxLength={200}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label={t('maintenance.hours.panel.noteText')}
              className={`${inputCls} !w-auto min-w-0 flex-1`}
            />
            <Button type="submit" size="sm" disabled={!text.trim() || !date}>
              {t('maintenance.hours.panel.saveNote')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
