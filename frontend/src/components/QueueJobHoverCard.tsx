import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Layers, FolderKanban, Receipt, Printer as PrinterIcon } from 'lucide-react';
import { formatDuration, formatTimeOnly, parseLocalDateKey } from '../utils/date';
import type { PrintQueueItem } from '../api/client';
import { api } from '../api/client';

/** Everything the timeline knows about one bar. Mirrors the view's own
 *  ScheduleEvent so the card never recomputes a forecast. */
export interface QueueJobHoverEvent {
  item: PrintQueueItem;
  estimatedStart: Date;
  estimatedEnd: Date;
  progress?: number;
  type: 'printing' | 'queued';
}

interface QueueJobHoverCardProps {
  event: QueueJobHoverEvent;
  /** The bar the card hangs from. Fixed-positioned above it, flipped below
   *  when the lane sits too close to the top of the viewport. */
  anchor: HTMLElement;
  nowMs: number;
  t: (key: string, options?: Record<string, unknown>) => string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const CARD_WIDTH_PX = 340; // keep in sync with the w-[340px] class
const GAP_PX = 8;
const EDGE_PX = 8;

/** The slicer stores "RRGGBBAA" (with or without '#'); CSS wants "#RRGGBB". */
function swatchColor(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.replace(/^#/, '').slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-px">
      <span className="text-bambu-gray shrink-0">{label}</span>
      <span className="text-right truncate text-white/90">{children}</span>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 border-b border-white/[0.07] last:border-b-0">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-bambu-gray mb-1">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

/** Rich hover card for a timeline bar: schedule, print settings, the PDM
 *  project/revision and the Aito client task behind the job. Replaces the
 *  native `title` tooltip, which truncated to one line and could show none
 *  of this. Portaled + fixed so it escapes the lanes' overflow clipping. */
export function QueueJobHoverCard({ event, anchor, nowMs, t, onMouseEnter, onMouseLeave }: QueueJobHoverCardProps) {
  const { item } = event;
  const cardRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; above: boolean } | null>(null);

  // Measure after mount (the card has no height before its first paint) and
  // re-measure on scroll/resize so the card tracks its bar. useLayoutEffect
  // so the first visible frame is already in place instead of at (0, 0).
  useLayoutEffect(() => {
    const compute = () => {
      const card = cardRef.current;
      if (!card) return;
      const rect = anchor.getBoundingClientRect();
      const height = card.offsetHeight;
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      const above = spaceAbove >= height + GAP_PX || spaceAbove >= spaceBelow;
      const top = above ? rect.top - height - GAP_PX : rect.bottom + GAP_PX;
      const left = Math.max(EDGE_PX, Math.min(rect.left, window.innerWidth - CARD_WIDTH_PX - EDGE_PX));
      setCoords({ top, left, above });
    };
    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchor, item.id]);

  const name = item.archive_name || item.library_file_name || `#${item.id}`;
  const thumbnailUrl = item.archive_thumbnail
    ? api.getArchiveThumbnail(item.archive_id!)
    : item.library_file_thumbnail
      ? api.getLibraryFileThumbnailUrl(item.library_file_id!)
      : null;
  const isPrinting = event.type === 'printing';
  const remainingSeconds = isPrinting ? Math.max(0, Math.round((event.estimatedEnd.getTime() - nowMs) / 1000)) : null;
  const swatch = swatchColor(item.filament_color);
  const c = (key: string, options?: Record<string, unknown>) => t(`queue.timeline.card.${key}`, options);
  const onOff = (value: boolean) => (value ? c('on') : c('off'));
  const hasProject = item.project_name != null;
  const hasTask = item.aito_task_id != null && (item.aito_client_name != null || item.aito_task_title != null);
  // A due date is a calendar day, not an instant: parse it as local so a
  // UTC-midnight reading never shows the day before west of Greenwich.
  const dueDate = item.aito_due_date
    ? parseLocalDateKey(item.aito_due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      data-testid="queue-job-hover-card"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // A floating material, not another lane: lighter than the page,
      // frosted over whatever it covers, a bright top edge where light
      // catches it, and a deep drop shadow so it reads as lifted. The
      // status tint on the ring ties it back to the bar it came from.
      className={`queue-job-hover-card fixed z-[60] w-[340px] rounded-xl text-xs text-white ${
        isPrinting ? 'queue-job-hover-card--printing' : 'queue-job-hover-card--queued'
      } ${coords?.above === false ? 'queue-job-hover-card--below' : ''}`}
      style={{
        top: coords?.top ?? 0,
        left: coords?.left ?? 0,
        visibility: coords ? 'visible' : 'hidden',
      }}
    >
      {/* Header: thumbnail, name, status */}
      <div className="flex gap-3 p-3 border-b border-white/[0.07]">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=""
            className="w-14 h-14 rounded-lg object-cover shrink-0 bg-bambu-dark brightness-125 contrast-110"
          />
        ) : (
          <div className="w-14 h-14 rounded-lg shrink-0 bg-bambu-dark grid place-items-center text-bambu-gray">
            <Layers className="w-6 h-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight break-words">{name}</div>
          <div className="text-bambu-gray mt-0.5 flex items-center gap-1 truncate">
            <PrinterIcon className="w-3 h-3 shrink-0" />
            <span className="truncate">{item.printer_name || item.target_model || '—'}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span
              className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                isPrinting
                  ? 'bg-blue-500/20 text-blue-300 border-blue-400/40'
                  : 'bg-bambu-green/15 text-bambu-green border-bambu-green/35'
              }`}
            >
              {isPrinting
                ? event.progress != null
                  ? `${c('printing')} · ${Math.round(event.progress)}%`
                  : c('printing')
                : c('queued')}
            </span>
            {item.batch_name && (
              <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-cyan-500/15 text-cyan-300 border-cyan-400/35 truncate max-w-full">
                {c('batch')} · {item.batch_name}
              </span>
            )}
          </div>
          {isPrinting && event.progress != null && (
            <div className="h-1 mt-1.5 rounded bg-white/10 overflow-hidden" aria-hidden>
              <div className="h-full bg-blue-400" style={{ width: `${event.progress}%` }} />
            </div>
          )}
        </div>
      </div>

      <Section icon={<Clock className="w-3 h-3" />} title={c('schedule')}>
        <div className="grid grid-cols-2 gap-x-4">
          <Row label={c('start')}>{formatTimeOnly(event.estimatedStart)}</Row>
          <Row label={c('end')}>{formatTimeOnly(event.estimatedEnd)}</Row>
          <Row label={c('duration')}>{item.print_time_seconds ? formatDuration(item.print_time_seconds) : '—'}</Row>
          {remainingSeconds != null ? (
            <Row label={c('remaining')}>{formatDuration(remainingSeconds)}</Row>
          ) : (
            <Row label={c('queuedBy')}>{item.created_by_username || '—'}</Row>
          )}
        </div>
      </Section>

      <Section icon={<Layers className="w-3 h-3" />} title={c('print')}>
        <div className="grid grid-cols-2 gap-x-4">
          <Row label={c('filament')}>
            {swatch && (
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm border border-white/20 mr-1.5 align-[-1px]"
                style={{ backgroundColor: swatch }}
                aria-hidden
              />
            )}
            {item.filament_type || '—'}
          </Row>
          <Row label={c('weight')}>{item.filament_used_grams != null ? `${Math.round(item.filament_used_grams)} g` : '—'}</Row>
          <Row label={c('plate')}>{item.bed_type || '—'}</Row>
          <Row label={c('nozzle')}>{item.nozzle_diameter != null ? `${item.nozzle_diameter} mm` : '—'}</Row>
          <Row label={c('layer')}>{item.layer_height != null ? `${item.layer_height} mm` : '—'}</Row>
          <Row label={c('slicedFor')}>{item.sliced_for_model || '—'}</Row>
          <Row label="AMS">{onOff(item.use_ams)}</Row>
          <Row label={c('timelapse')}>{onOff(item.timelapse)}</Row>
        </div>
      </Section>

      <Section icon={<FolderKanban className="w-3 h-3" />} title={c('project')}>
        {hasProject ? (
          <>
            <Row label={item.project_code || c('project')}>{item.project_name}</Row>
            {item.revision_item_name && <Row label={c('item')}>{item.revision_item_name}</Row>}
            {item.revision_number != null && (
              <Row label={c('revision')}>
                R{item.revision_number}
                {item.revision_status && (
                  <span
                    className={`ml-1.5 inline-block text-[10px] font-semibold px-1.5 py-px rounded-full border ${
                      item.revision_status === 'valide'
                        ? 'bg-bambu-green/15 text-bambu-green border-bambu-green/35'
                        : item.revision_status === 'obsolete'
                          ? 'bg-bambu-dark-tertiary text-bambu-gray border-bambu-gray/30'
                          : 'bg-amber-500/15 text-amber-300 border-amber-400/35'
                    }`}
                  >
                    {t(`projectsPdm.files.status${item.revision_status === 'valide' ? 'Valide' : item.revision_status === 'obsolete' ? 'Obsolete' : 'Wip'}`)}
                  </span>
                )}
              </Row>
            )}
          </>
        ) : (
          <div className="text-bambu-gray">{c('noProject')}</div>
        )}
      </Section>

      <Section icon={<Receipt className="w-3 h-3" />} title={c('clientTask')}>
        {hasTask ? (
          <>
            <Row label={c('client')}>{item.aito_client_name || '—'}</Row>
            {item.aito_task_title && <Row label={c('task')}>{item.aito_task_title}</Row>}
            <div className="grid grid-cols-2 gap-x-4">
              <Row label={c('due')}>{dueDate || '—'}</Row>
              <Row label={c('quantity')}>{item.aito_quantity ?? '—'}</Row>
            </div>
            {item.aito_board_column && (
              <Row label={c('stage')}>{t(`aito.columns.${item.aito_board_column}`)}</Row>
            )}
          </>
        ) : (
          <div className="text-bambu-gray">{c('noTask')}</div>
        )}
      </Section>
    </div>,
    document.body,
  );
}
