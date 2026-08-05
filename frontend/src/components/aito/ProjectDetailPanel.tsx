import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Copy, ExternalLink, Loader2, Mail, Phone, Plane, RefreshCw, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DeleteHoldButton } from './DeleteHoldButton';
import { ActivityRail } from './history/ActivityRail';
import { PanelAgeStat } from './PanelAgeStat';
import { eyebrowCls } from './panelTypography';
import { ProjectDoneAction } from './ProjectDoneAction';
import { ProjectProgress } from './ProjectProgress';
import { QuotePrintButton } from './QuotePrintButton';
import { QuoteStatusActions } from './QuoteStatusActions';
import {
  quoteStatusLabelKey,
  quoteStatusTone,
  QUOTE_STATUS_PILL_TONE_CLASSES,
  QUOTE_STATUS_TEXT_TONE_CLASSES,
} from './quoteStatus';
import { ShippingCard } from './ShippingCard';
import { stagesWithWork } from './services';
import { StageRail } from './StageRail';
import { TaskEditor } from './TaskEditor';
import { AITO_CARD_VT_NAME } from '../../hooks/useCardMorph';
import { useCurrency } from '../../hooks/useCurrency';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useLatestProjectEvent } from '../../hooks/useLatestProjectEvent';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { useProjectTasks } from '../../hooks/useProjectTasks';
import { api, type AitoEvent, type AitoProject, type AitoProjectUpdate } from '../../api/client';
import { Money } from '../calculator/shared';
import { ageAnchor, agingColorCls } from '../../utils/aitoAging';
import { copyTextToClipboard } from '../../utils/clipboard';
import { elapsedDays, parseUTCDate } from '../../utils/date';
import { formatMoney } from '../../utils/pricing';
import { applyDescription, applySyncState } from '../../utils/aitoOptimistic';
import { islandLabel } from '../../utils/shippingDraft';
import { taskDraftToTaskCreate } from '../../utils/taskDraft';
import { focusRingCls, inputCls } from '../formStyles';
import { useToast } from '../../contexts/ToastContext';

/** Explicit map rather than a template literal key: the i18n gate scans for
 *  literal `t('...')` calls, and a dynamic key is invisible to it. */
const SYNC_LABEL_KEY: Record<string, string> = {
  pending: 'aito.syncPendingLabel',
  error: 'aito.syncError',
  locked: 'aito.quoteLocked',
};

/** Why the backend's status reconciler is stuck, keyed by the stored fact it
 *  records — same explicit-map reason as SYNC_LABEL_KEY above.
 *
 *  Deliberately NOT folded into the sync row: a block is recorded whatever
 *  `quote_sync_state` happens to be, and the sync row only renders for three
 *  of its five values. A conflict written into a field the UI renders in one
 *  state only is a conflict that reaches nobody, which is exactly how the
 *  previous design lost them. */
const BLOCK_MESSAGE_KEY: Record<string, string> = {
  conflict: 'aito.quoteConflict',
  rejected: 'aito.quoteRejected',
};

/** Renders a Zoho estimate status through the shared quote-status labels, so
 *  every surface that shows one — the header's eyebrow pill, the Quote card's
 *  Status row, and the block-message interpolation below — agrees on the
 *  same word. An untranslated status falls back to the raw string; a null
 *  status (only reachable from the block-message call sites, which already
 *  guard on `project.quote_status_block`) renders an em dash. Module-level,
 *  not a closure over one component's `t`, because `PanelHeader` needs it too
 *  and the two must never drift into two different fallback rules. */
function quoteStatusText(t: (key: string) => string, status: string | null): string {
  if (!status) return '—';
  const key = quoteStatusLabelKey(status);
  return key ? t(key) : status;
}

interface ProjectDetailPanelProps {
  project: AitoProject;
  onClose: () => void;
  /** Omitted for a project that is already in the trash — see AitoPage. The
   *  delete button is then not rendered at all. */
  onDelete?: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** A contact detail that copies itself.
 *
 *  It used to be a `tel:` / `mailto:` link, which on a desktop workshop machine
 *  is a way to hand the number to whatever application once claimed the
 *  protocol — usually nothing, sometimes something unwanted. What the value is
 *  actually FOR is pasting: into a phone, into a mail client that is already
 *  open, into the shop's own paperwork. So the click copies, and does only
 *  that.
 *
 *  `copyTextToClipboard`, not `navigator.clipboard` directly: Bambuddy is
 *  normally reached over plain HTTP on a LAN address, where the async clipboard
 *  API does not exist and the helper's textarea fallback is the only path that
 *  works.
 *
 *  The acknowledgement is a check mark for 1.5s — the same dwell
 *  `SaveIndicator` uses below, so the two transient confirmations in this panel
 *  behave alike. A copy that fails leaves the icon alone rather than raising a
 *  toast, which is what `PrinterInfoModal` does with the same helper: the check
 *  mark IS the claim that it worked, so withholding it is the honest report.
 *
 *  Exported for `ShippingCard`, which needs the identical copy-not-link
 *  behaviour for the shipment's recipient phone — the freight desk calls that
 *  number the same way the workshop calls the client's, and a second copy of
 *  this component would be the one place the two could drift. */
export function CopyableValue({
  value,
  label,
  icon: Icon,
}: {
  value: string;
  label: string;
  /** A leading glyph — `Phone` / `Mail` in the header — purely decorative
   *  (the accessible name is still the label+value pair below), so it needs
   *  no `aria-hidden` of its own beyond what lucide's icons already carry. */
  icon?: LucideIcon;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      // The value alone is the name a screen reader would read; this says what
      // pressing it does, which is the part that is not obvious.
      aria-label={`${label}: ${value} — ${t('common.copy')}`}
      title={copied ? t('common.copied') : t('common.copy')}
      onClick={async () => {
        if (await copyTextToClipboard(value)) setCopied(true);
      }}
      className="group inline-flex items-center gap-1.5 max-w-full min-w-0 rounded-md text-bambu-gray-light hover:text-bambu-green transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
    >
      {Icon && <Icon className="w-3.5 h-3.5 flex-shrink-0" />}
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="w-3.5 h-3.5 flex-shrink-0 text-bambu-green animate-tick-in" />
      ) : (
        // Hinted rather than announced: the row is a definition list of facts,
        // and a permanent icon on two of them would read as two buttons in a
        // list of text. It surfaces when the pointer is on the value it
        // belongs to.
        <Copy className="w-3.5 h-3.5 flex-shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 transition-opacity" />
      )}
    </button>
  );
}

/** Money done over money quoted, as a ring.
 *
 *  Deliberately not the step count the card's bar uses. Seven steps on a
 *  typical project are worth between 3 500 and 10 000 FCFP each, so "3/7" and
 *  "how much of this job is done" are different numbers; the line beneath the
 *  ring gives both so neither reading is lost. */
function ValueRing({ done, total, currency }: { done: number; total: number; currency: string }) {
  const { t } = useTranslation();
  const size = 42;
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = total > 0 ? done / total : 0;

  return (
    <svg
      data-testid="panel-value-ring"
      role="progressbar"
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      // formatMoney, not the raw number: the visible caption right beside the
      // ring uses formatMoney too, and a screen reader announcing "3500 done"
      // next to a sighted "$3,500.00 done" would disagree about the figure.
      aria-label={t('aito.amountDone', { amount: formatMoney(done, currency) })}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="-rotate-90 flex-shrink-0"
    >
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={3} className="stroke-bambu-dark-tertiary" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        className="stroke-bambu-green transition-[stroke-dashoffset] duration-300 ease-[var(--ease-signature)] motion-reduce:transition-none"
      />
    </svg>
  );
}

/** The panel's title band: the client as the heading (with the project
 *  reference and quote number as an eyebrow above it and the phone/email as
 *  copyable chips below), and the value-weighted ring plus project total on
 *  the right. Everything a card cannot fit is below this in the body; this is
 *  everything the operator needs before reading any of it. */
function PanelHeader({
  project,
  currency,
  valueDone,
  valueTotal,
  quotedTotal,
  stepsDone,
  stepsTotal,
}: {
  project: AitoProject;
  currency: string;
  valueDone: number;
  valueTotal: number;
  /** What the client is actually charged: the discounted work value plus the
   *  air freight. `build_line_items` puts the shipping line on the estimate,
   *  so `estimate.total` includes it — a header that showed `valueTotal`
   *  alone could never equal the quote on a shipped project.
   *
   *  Kept separate from `valueTotal` rather than folded into it because the
   *  RING is a progress indicator over work anyone can tick, and freight is
   *  not a step: adding it to the ring's denominator would stop a finished
   *  project ever reading 100 %. */
  quotedTotal: number;
  /** Summed from `stagesWithWork(tasks)`, NOT `project.steps_done`/`steps_total`.
   *  Those are server board fields that lag a local tick; stagesWithWork is
   *  local and updates the instant a step is ticked. Money and step count used
   *  to come from two different sources, so ticking a step made the caption
   *  visibly disagree with itself until the next board refresh. */
  stepsDone: number;
  stepsTotal: number;
}) {
  const { t } = useTranslation();
  // Same query key ShippingCard and the create drawer use, so this shares
  // their cache rather than issuing its own request for a table that rarely
  // changes. Only needed for the LABEL — the pill itself gates on
  // `project.shipping_island` alone, never on this query having resolved.
  const shippingServicesQuery = useQuery({
    queryKey: ['aito-shipping-services'],
    queryFn: api.getAitoShippingServices,
    staleTime: 60 * 60_000,
  });
  // Shared with ShippingCard and the create drawer's own rail/checklist — see
  // `islandLabel`'s doc for why the degrade has to be one computation, not
  // three: this pill and the card twelve lines below it used to fall back
  // differently (raw key here, a naive capitalisation there) and could show
  // two different spellings of the same island in one panel with Zoho down.
  const shippingIslandLabel =
    project.shipping_island !== null ? islandLabel(project.shipping_island, shippingServicesQuery.data?.services ?? []) : null;
  return (
    <div
      // `relative z-[2]` so the cast shadow below paints ONTO the body rather
      // than under it — without a stacking context the body's own background
      // covers it and the lift disappears.
      className="flex-shrink-0 relative z-[2] px-5 py-3 flex items-center gap-5"
      style={{
        // The band is a RAISED masthead, not a tinted strip. Two things carry
        // that and both were missing: the base is a step above the surface
        // tier, and the band casts a shadow down onto the canvas. Painted flat
        // on `--bg-secondary` with no shadow, it read as part of the body no
        // matter how the type was tuned.
        //
        // `--bg-tertiary` mixed into `--bg-secondary`, not `#fff`: a fixed
        // white percentage lifts in dark mode and does nothing in light mode,
        // where white over white is white. The tertiary tier is lighter than
        // secondary in dark palettes and darker in light ones, so this reads
        // as a distinct band in both.
        //
        // 135deg, not 180: on a ~1200x90 band a diagonal axis reads as a
        // near-horizontal fade, so the wash sits behind the client name and
        // clears before the total. The vertical version tints the top of
        // the band — where the small grey eyebrow lives — and casts over the
        // one number that must not compete with a colour.
        backgroundImage:
          'linear-gradient(135deg,' +
          ' color-mix(in srgb, var(--accent) 12%, color-mix(in srgb, var(--bg-tertiary) 45%, var(--bg-secondary))),' +
          ' color-mix(in srgb, var(--bg-tertiary) 45%, var(--bg-secondary)))',
        // No bottom border — the cast shadow below is what separates the band
        // from the body now, and a tinted hairline on top of it read as two
        // separators doing one job.
        boxShadow: '0 12px 26px -14px rgba(0, 0, 0, 0.8)',
      }}
    >
      <div className="flex-1 min-w-0">
        {/* `eyebrowCls`, not `text-xs tracking-wide`: the reference eyebrow is
            .72rem at .08em, and Tailwind's nearest pair (.75rem / .025em) is
            a third of that tracking — on four uppercase words set at 10px the
            difference between .025em and .08em is the difference between a
            label and a caption. Shared by all four items on this row so they
            cannot drift apart. */}
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`${eyebrowCls} text-bambu-gray`}>{t('aito.projectRef', { id: project.id })}</span>
          {project.quote_number && (
            <>
              <span className={`${eyebrowCls} text-bambu-gray opacity-45`}>·</span>
              {project.quote_url ? (
                <a
                  href={project.quote_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('aito.quoteOpenInZoho')}
                  // green-LIGHT, not green: on the accent-washed band the base
                  // accent sits too close to the wash to read as a link.
                  className={`${eyebrowCls} text-bambu-green-light hover:text-bambu-green-light/80 inline-flex items-center gap-1`}
                >
                  {project.quote_number}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <span className={`${eyebrowCls} text-bambu-gray`}>{project.quote_number}</span>
              )}
            </>
          )}
          {/* The quote's own Zoho status, not the board column: the column
              already implies roughly where the project sits (see
              aito_board_rules.evaluate), but "the quote itself was accepted"
              is a fact about Zoho, not about the board, and is otherwise only
              readable by opening the Quote card lower in the left column. */}
          {project.quote_status && (
            <span
              data-testid="panel-quote-status-pill"
              className={`${eyebrowCls} border rounded-[.4rem] px-[.4rem] py-[.05rem] ${QUOTE_STATUS_PILL_TONE_CLASSES[quoteStatusTone(project.quote_status)]}`}
            >
              {quoteStatusText(t, project.quote_status)}
            </span>
          )}
          {/* Sky, not green: green is the colour of WORK on this board, and a
              destination is not work. Rendered in the header rather than only
              in the card below because this is the fact the person opening
              the panel most needs before scrolling anywhere. */}
          {project.shipping_island !== null && (
            <span
              data-testid="panel-shipping-pill"
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/30 bg-sky-400/[0.14] px-2 py-0.5 text-[11px] font-semibold text-sky-400"
            >
              <Plane className="h-3.5 w-3.5" aria-hidden="true" />
              {shippingIslandLabel}
            </span>
          )}
        </div>
        {/* 1.35rem at -.01em, not `text-xl`: the reference title is a step
            larger than Tailwind's 1.25rem, and the negative tracking is what
            keeps a long company name from reading as loose at that size. */}
        {/* A building for a company, a person for an individual. `null` — a
            legacy card predating the flag — reads as an individual, the same
            fallback the old "Client name" label used.
            The glyph is `aria-hidden` and the distinction is carried in text
            for assistive tech instead: an icon alone would make the company/
            person split visible to sighted users only, and the heading's
            accessible name is what a screen reader announces on open. */}
        <h2 className="text-[1.35rem] leading-tight font-semibold tracking-[-0.01em] text-white flex items-center gap-2 min-w-0">
          {/* strokeWidth 2.5 rather than lucide's default 2, so the glyph's
              stems match the semibold weight of the name beside it — at the
              default the icon reads as a lighter, unrelated mark. */}
          {project.client_is_company ? (
            <Building2
              className="w-[1.1rem] h-[1.1rem] flex-shrink-0 text-white"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          ) : (
            <User
              className="w-[1.1rem] h-[1.1rem] flex-shrink-0 text-white"
              strokeWidth={2.5}
              aria-hidden="true"
            />
          )}
          <span className="sr-only">
            {project.client_is_company ? t('aito.companyNameLabel') : t('aito.clientNameLabel')}
          </span>
          <span className="truncate">{project.client_name ?? t('aito.noClient')}</span>
        </h2>
        {/* mt-2.5 and medium weight: at mt-1 the contacts crowded the title,
            and at regular weight they receded into the band rather than
            reading as the two things you copy out of this header. */}
        <div className="flex items-center gap-4 mt-2.5 text-[.82rem] font-medium">
          {project.client_phone && (
            <CopyableValue value={project.client_phone} label={t('aito.phoneLabel')} icon={Phone} />
          )}
          {project.client_email && (
            <CopyableValue value={project.client_email} label={t('aito.emailLabel')} icon={Mail} />
          )}
        </div>
      </div>

      {/* Hidden below md: the header is one flex row and the client name has
          first claim on the width. The Record card's echo carries the age on
          narrow screens, so nothing is lost, only relocated. */}
      <div className="hidden md:block w-px self-stretch bg-bambu-dark-tertiary" />
      <div className="hidden md:flex flex-shrink-0">
        <PanelAgeStat project={project} />
      </div>
      <div className="w-px self-stretch bg-bambu-dark-tertiary" />

      <div className="flex items-center gap-3 flex-shrink-0">
        <ValueRing done={valueDone} total={valueTotal} currency={currency} />
        <div className="text-right">
          {/* -.02em: the total is the largest run of digits in the panel, and
              tabular figures at 1.5rem sit noticeably loose without it. */}
          <Money
            testId="panel-header-total"
            currency={currency}
            value={quotedTotal}
            className="block text-[1.5rem] leading-tight font-semibold tracking-[-0.02em] text-white"
          />
          <span data-testid="panel-header-caption" className="block text-xs text-bambu-gray tabular-nums">
            {t('aito.amountDone', { amount: formatMoney(valueDone, currency) })}
            {' · '}
            {t('aito.stepsCount', { done: stepsDone, total: stepsTotal })}
          </span>
        </div>
      </div>
    </div>
  );
}

/** One group of the left rail. `bg-bambu-dark-secondary` with a border and NO
 *  shadow: only the task cards cast one, so the column the operator works in
 *  stays the front plane. Spreading the shadow over every group is what makes
 *  the task list stop being the focus. */
function PanelCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p data-testid="panel-card-heading" className="text-xs uppercase tracking-wide text-bambu-gray">
          {title}
        </p>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Explicit map, same reason as SYNC_LABEL_KEY: a dynamic key is invisible to
 *  the i18n gate's literal scan. */
const ACTOR_FALLBACK_KEY: Record<string, string> = {
  user: 'aito.actorUnknownUser',
  client: 'aito.actorClient',
  system: 'aito.actorAutomatic',
};

function RecordCard({ project, latestEvent }: { project: AitoProject; latestEvent: AitoEvent | undefined }) {
  const { t, i18n } = useTranslation();
  const created = parseUTCDate(project.created_at);
  // Both halves from the same event. A mirrored Zoho comment carries Books'
  // timestamp rather than ours — which is exactly why occurred_at is stored
  // apart from created_at — so pairing updated_at with this actor's name would
  // produce a line whose time and name describe different things.
  const activityAt = latestEvent ? parseUTCDate(latestEvent.occurred_at) : parseUTCDate(project.updated_at);
  const actor = latestEvent
    ? (latestEvent.actor_name ?? t(ACTOR_FALLBACK_KEY[latestEvent.actor_class] ?? 'aito.actorUnknown'))
    : null;

  // Date only, no time: "{when} · {who}" has to fit one line of the rail, and
  // with the time in it ("7/29/26, 9:22 AM · admin") the author wrapped onto
  // a ragged second line. The exact timestamps stay in the timeline one
  // column over — this card answers "when, roughly, and by whom", so the
  // full string is a hover away (`title` below), not a second line.
  const short = (d: Date | null) => (d ? d.toLocaleDateString(i18n.language, { dateStyle: 'short' }) : '—');
  const full = (d: Date | null) =>
    d ? d.toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : undefined;

  // The echo attaches to whichever row owns the anchor, never to a date it is
  // not measuring: a job accepted a fortnight after it was created must not
  // show "(12 d)" beside its creation date.
  const age = ageAnchor(project);
  const days = elapsedDays(age.raw);
  const echo =
    days === null ? null : (
      <span data-testid="record-age" className={agingColorCls(project, age.at)}>
        {' '}
        ({t('aito.ageDaysShort', { days })})
      </span>
    );

  return (
    <PanelCard title={t('aito.recordLabel')}>
      {/* Same shape and type as the Quote card above — label left, value
          right, one row each. These were stacked pairs while the left column
          was 17rem and `{when} · {who}` could not fit a line; at the column's
          current width it does, and two adjacent cards in one rail should not
          read as two different kinds of list. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm items-baseline">
        {project.quote_salesperson && (
          <>
            <dt className="text-bambu-gray">{t('aito.sellerLabel')}</dt>
            <dd className="text-right min-w-0 truncate text-white">{project.quote_salesperson}</dd>
          </>
        )}
        {age.anchor === 'accepted' && (
          <>
            <dt className="text-bambu-gray">{t('aito.ageAnchorAccepted')}</dt>
            <dd
              data-testid="record-accepted"
              title={full(age.at)}
              className="text-right min-w-0 truncate text-white"
            >
              {short(age.at)}
              {echo}
            </dd>
          </>
        )}
        <dt className="text-bambu-gray">{t('aito.createdLabel')}</dt>
        <dd data-testid="record-created" title={full(created)} className="text-right min-w-0 truncate text-white">
          {short(created)} · {project.created_by ?? t('aito.actorUnknown')}
          {age.anchor === 'created' && echo}
        </dd>
        <dt className="text-bambu-gray">{t('aito.lastActivity')}</dt>
        <dd data-testid="record-activity" title={full(activityAt)} className="text-right min-w-0 truncate text-white">
          {short(activityAt)}
          {actor && ` · ${actor}`}
        </dd>
      </dl>
    </PanelCard>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  if (state === 'saving') return <Loader2 className="w-3.5 h-3.5 text-bambu-gray animate-spin" />;
  if (state === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-bambu-green animate-fade-in">
        <Check className="w-3.5 h-3.5" />
        {t('aito.saved')}
      </span>
    );
  }
  return null;
}

/** Everything a card cannot fit: the untruncated description, the timestamps
 *  and the stage. Shares AITO_CARD_VT_NAME with the card it grew out of, so the
 *  browser morphs one into the other (see useCardMorph). */
export function ProjectDetailPanel({ project, onClose, onDelete }: ProjectDetailPanelProps) {
  const { t } = useTranslation();

  // A status rendered through the shared quote-status labels (see
  // `quoteStatusText` above), so the two sides of a block message are
  // localised too rather than raw Zoho English.
  const statusLabel = (status: string | null): string => quoteStatusText(t, status);
  const blockKey = project.quote_status_block ? BLOCK_MESSAGE_KEY[project.quote_status_block] : null;

  /** Whether the Quote card has anything to say beyond the number itself.
   *
   *  The card is gated on `quote_number` so a hand-made project shows no
   *  empty "Quote" heading — but these three messages must never be gated
   *  with it. A sync error, a status block or a declined quote on a project
   *  whose number is missing would vanish into a card that no longer renders,
   *  and a conflict that reaches nobody is exactly how the previous design
   *  lost them. So the card opens for either reason. */
  const hasQuoteMessage =
    Boolean(SYNC_LABEL_KEY[project.quote_sync_state]) ||
    Boolean(blockKey) ||
    project.quote_status === 'declined';

  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const updateMutation = useOptimisticBoardMutation<AitoProject, AitoProjectUpdate>({
    mutationFn: (patch) => api.updateAitoProject(project.id, patch),
    // A description edit shows immediately; the retry-sync button sends the
    // description UNCHANGED (its only job is to re-mark the project pending
    // for the worker), so it writes the sync state instead. One transform,
    // branching on which of the two this is.
    transform: (previous, patch) => {
      if (patch.description !== undefined && patch.description !== project.description) {
        return applyDescription(previous, project.id, patch.description);
      }
      return applySyncState(previous, project.id, 'pending');
    },
    flashId: () => project.id,
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const { tasks, onTasksChange, onRemoveTask, onRowBlur, pendingTaskUids } = useProjectTasks(project.id);
  const { data: latestEvent } = useLatestProjectEvent(project.id);

  // Value-weighted, not step-weighted — see ValueRing's doc.
  const stageWork = stagesWithWork(tasks);
  const valueTotal = stageWork.reduce((sum, s) => sum + s.value, 0);
  const valueDone = stageWork.reduce((sum, s) => sum + s.valueDone, 0);
  // The figure the quote states, not the work value — see PanelHeader's
  // `quotedTotal` doc for why freight is added here and not to the ring.
  const quotedTotal = valueTotal + (project.shipping_price ?? 0);
  // Same source as the money above, not project.steps_done/steps_total — see
  // PanelHeader's doc on why those two used to visibly disagree.
  const stepsDone = stageWork.reduce((sum, s) => sum + s.stepsDone, 0);
  const stepsTotal = stageWork.reduce((sum, s) => sum + s.stepsTotal, 0);
  const currency = useCurrency();

  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState(project.description);
  const [descState, setDescState] = useState<SaveState>('idle');

  // Follow the server value while idle; never clobber text being typed.
  useEffect(() => {
    if (!editingDesc) setDraft(project.description);
  }, [project.description, editingDesc]);

  // 'saved' is a transient acknowledgement, not a state to sit in.
  useEffect(() => {
    if (descState !== 'saved') return;
    const id = setTimeout(() => setDescState('idle'), 1500);
    return () => clearTimeout(id);
  }, [descState]);

  const saveDescription = () => {
    setEditingDesc(false);
    const next = draft.trim();
    // Blank is rejected by the backend (min_length=1) and is almost always an
    // accidental select-all-delete, so revert rather than round-trip an error.
    if (!next || next === project.description) {
      setDraft(project.description);
      return;
    }
    setDescState('saving');
    updateMutation.mutate(
      { description: next },
      {
        onSuccess: () => setDescState('saved'),
        onError: () => {
          setDescState('error');
          setDraft(project.description);
        },
      },
    );
  };

  // Regenerates the description from the live tasks through the same
  // stateless /aito/summarize endpoint the creation drawer uses, then saves
  // immediately through the manual-edit path so the descState indicator and
  // the optimistic board update behave identically. A failed generation only
  // toasts — unlike the drawer, this panel always has a real description, and
  // buildFallbackSummary would replace it with a worse one.
  const regenerateMutation = useMutation({
    mutationFn: () => api.summarizeAitoProject(tasks.map(taskDraftToTaskCreate)),
    onSuccess: ({ summary }) => {
      const next = summary.trim();
      if (!next || next === project.description) {
        setDescState('saved');
        return;
      }
      setDescState('saving');
      updateMutation.mutate(
        { description: next },
        {
          onSuccess: () => setDescState('saved'),
          onError: () => {
            setDescState('error');
            setDraft(project.description);
          },
        },
      );
    },
    onError: () => showToast(t('aito.summaryFallback'), 'error'),
  });

  const editingRef = useRef(false);
  editingRef.current = editingDesc;

  // The dialog takes focus on mount (it already carries
  // role/aria-modal/aria-label, so focusing it announces the panel by its
  // client name) and Escape closes it — both via the shared hook, see its
  // doc. `!editingRef.current` guards the Escape path specifically: the
  // description textarea's own `onKeyDown` (below) already stops propagation
  // and aborts the edit instead, so in practice this only matters if focus is
  // ever elsewhere while `editingDesc` is true. The backdrop's `onMouseDown`
  // deliberately does NOT share this guard — see its own comment below.
  const { dialogRef } = useDismissableDialog(() => {
    if (!editingRef.current) onClose();
  });

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 [view-transition-name:aito-backdrop]"
      onMouseDown={(e) => {
        // Unguarded, unlike the hook's Escape path above: a backdrop click is
        // an explicit, deliberate dismissal in a way a stray Escape key isn't,
        // so it closes even mid-edit rather than silently doing nothing.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={project.client_name ?? t('aito.noClient')}
        tabIndex={-1}
        style={{ viewTransitionName: AITO_CARD_VT_NAME }}
        // Canvas, not panel: the body behind the header/columns/footer is
        // `bg-bambu-dark`, one tier darker than the `bg-bambu-dark-secondary`
        // every card, the header and the footer sit on. That two-tier gap is
        // the entire elevation effect — it needs no new colour, because
        // `--bg-primary`/`--bg-secondary` already mean exactly this pairing in
        // every palette (including light mode). No accent glow on this
        // border either: tried behind the `black/70` backdrop, and invisible
        // at every strength short of garish — the lift comes from the canvas
        // contrast and the header's own cast shadow.
        // `overflow-hidden` is load-bearing, not tidiness: the header carries a
        // full-bleed gradient and the footer a solid fill, both square-cornered
        // and both spanning the full width, so without it their corners paint
        // over this element's radius and the panel reads as a rectangle with
        // four notched corners.
        className="bg-bambu-dark rounded-[.85rem] overflow-hidden w-full max-w-[100rem] border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] focus:outline-none"
      >
        <PanelHeader
          project={project}
          currency={currency}
          valueDone={valueDone}
          valueTotal={valueTotal}
          quotedTotal={quotedTotal}
          stepsDone={stepsDone}
          stepsTotal={stepsTotal}
        />

        <div className="overflow-y-auto scrollbar-hide flex-1 min-h-0 lg:flex lg:flex-col lg:overflow-hidden">
          {/* Three columns, three scrollers — but only from `lg` up, where the
              grid is actually side by side. Below that the columns stack and
              the body's own scroller is the right one.

              The body itself carries no padding any more — each column below
              does (`px-5 py-4`), so a column's card content covers its full
              height against the canvas rather than floating inside a padded
              frame. That is also why the `lg:border-l` seams between columns
              are gone: the canvas/card contrast (plus the grid's own `gap`)
              does the separating now, the same job a hairline used to do.

              The history rail is an infinite query with no height of its own,
              so with a single shared scroller every "load more" pushed the
              description, the client and the tasks off the top of the screen.
              Capping the row at the panel's available height and letting each
              column scroll inside it is what keeps the header and the left
              column where the user left them.

              `lg:h-full` was tried first and silently did nothing: a percentage
              height only resolves against a parent whose height is definite,
              and this body's height comes out of the flex algorithm (`flex-1
              min-h-0` above), not an explicit value, so `h-full` fell back to
              `auto` — the content height — and never capped anything. The body
              itself has to become the definite-height parent instead, so at
              `lg` it turns into a non-scrolling flex column (`lg:flex
              lg:flex-col lg:overflow-hidden`) and the grid below takes
              `lg:flex-1` to get a real, definite height from it.

              `lg:min-h-0` is still required on the row and on every column,
              here and below: a flex/grid item defaults to `min-height: auto`
              and refuses to shrink below its content, so without it the
              definite height above is still ignored. Same reason AitoPage's
              board row carries it. */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,26rem)] gap-4 lg:gap-6 lg:flex-1 lg:min-h-0">
            <div className="space-y-4 min-w-0 lg:min-h-0 lg:overflow-y-auto scrollbar-hide px-5 py-4">
              <PanelCard
                title={t('aito.productDescription')}
                action={
                  // Violet marks AI actions across Aito (see AiSummaryPanel).
                  // Icon-only, so title + aria-label carry the name.
                  <button
                    type="button"
                    onClick={() => regenerateMutation.mutate()}
                    disabled={
                      regenerateMutation.isPending || descState === 'saving' || editingDesc || tasks.length === 0
                    }
                    title={t('aito.regenerate')}
                    aria-label={t('aito.regenerate')}
                    className={`-m-1 inline-flex items-center rounded-md p-1 text-violet-300 transition-colors hover:text-violet-200 disabled:opacity-40 ${focusRingCls}`}
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${regenerateMutation.isPending ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                }
              >
                <div className="flex items-start justify-between gap-2">
                  {editingDesc ? (
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={saveDescription}
                      maxLength={10000}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          // Stop the panel's window-level Escape handler: the first
                          // Escape abandons the edit, it does not close the panel.
                          e.stopPropagation();
                          setDraft(project.description);
                          setEditingDesc(false);
                        }
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDescription();
                      }}
                      rows={5}
                      className={`${inputCls} resize-none flex-1`}
                    />
                  ) : (
                    <p
                      role="button"
                      tabIndex={0}
                      aria-label={t('aito.editDescription')}
                      onClick={() => setEditingDesc(true)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setEditingDesc(true);
                        }
                      }}
                      className="flex-1 text-sm text-white whitespace-pre-wrap break-words cursor-text rounded-md -m-1 p-1 hover:bg-bambu-dark-tertiary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
                    >
                      {project.description}
                    </p>
                  )}
                  <SaveIndicator state={descState} />
                </div>
              </PanelCard>

              <PanelCard title={t('aito.stageAndWorkLeft')}>
                <StageRail tasks={tasks} column={project.column} currency={currency} />
              </PanelCard>

              {/* Imported projects only. The card itself is gated on
                  quote_number, not just its content: a hand-made project has
                  no quote at all, and a "Quote" heading over an empty body is
                  exactly the noise the omitted Email/Seller rows elsewhere in
                  this panel are built to avoid. The quote is a snapshot, so
                  this still renders with Zoho unreachable; only the link
                  needs Zoho. */}
              {(project.quote_number || hasQuoteMessage) && (
                <PanelCard title={t('aito.quoteSearchLabel')}>
                  {project.quote_number && (
                  <>
                  {/* A two-row definition list, not just the bare number: the
                      Number row is what used to be here alone, and Status
                      repeats the quote's Zoho status already shown as the
                      header's eyebrow pill — this is the row someone scanning
                      the left column (rather than the header) reaches for it
                      from. Rendered only when there is a status to show, same
                      omission rule the seller/email rows above follow. */}
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm items-baseline">
                    <dt className="text-bambu-gray">{t('aito.quoteNumberLabel')}</dt>
                    <dd className="text-right min-w-0">
                      {project.quote_url ? (
                        <a
                          href={project.quote_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t('aito.quoteOpenInZoho')}
                          className="text-white hover:text-bambu-green inline-flex items-center gap-1 min-w-0 truncate"
                        >
                          {project.quote_number}
                          <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                        </a>
                      ) : (
                        <span className="min-w-0 truncate text-white">{project.quote_number}</span>
                      )}
                    </dd>
                    {project.quote_status && (
                      <>
                        <dt className="text-bambu-gray">{t('common.status')}</dt>
                        <dd className={`text-right ${QUOTE_STATUS_TEXT_TONE_CLASSES[quoteStatusTone(project.quote_status)]}`}>
                          {quoteStatusText(t, project.quote_status)}
                        </dd>
                      </>
                    )}
                  </dl>

                  {/* Print is the only action here. "Open in Zoho" was a
                      second control doing exactly what the quote number above
                      already does when you click it — two affordances for one
                      destination, in a card six rows tall.
                      Full width because it is alone: a lone half-width button
                      leaves a ragged gap, and at this size the label is the
                      target rather than the icon beside it. */}
                  <QuotePrintButton project={project} withLabel className="w-full justify-center mt-3" />
                  </>
                  )}

              {/* Inside the Quote card, under its Number/Status rows — these
                  are all facts about the same quote, and as a loose block
                  between two cards they read as belonging to neither.
                  <dt>/<dd> gives assistive technology the label-to-value
                  association for free; the colon is markup, so no locale
                  string carries punctuation. Rendered only when there is
                  something to say: a row reading "up to date" on every idle
                  card would be noise, not information.
                  The card's own gate widens to `quote_number || hasQuoteMessage`
                  for these: a message with no quote number would otherwise be
                  swallowed by the card that no longer renders, which is
                  exactly how a previous redesign lost them. */}
              <dl className={`space-y-2 text-sm ${project.quote_number ? 'mt-2 pt-2 border-t border-bambu-dark-tertiary' : ''}`}>
                {/* Only when there is something to say. An idle project is the
                    normal case and a row reading "up to date" on every card
                    would be noise. */}
                {SYNC_LABEL_KEY[project.quote_sync_state] && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.sync')}:</dt>
                    <dd className="text-white min-w-0 text-right">
                      {t(SYNC_LABEL_KEY[project.quote_sync_state])}
                      {project.quote_sync_error && (
                        <span className="block text-xs text-bambu-gray">{project.quote_sync_error}</span>
                      )}
                      {project.quote_sync_state === 'locked' && (
                        <span className="block text-xs text-bambu-gray">{t('aito.quoteLockedHelp')}</span>
                      )}
                      {project.quote_sync_state === 'error' && (
                        <button
                          type="button"
                          onClick={() => updateMutation.mutate({ description: project.description })}
                          disabled={updateMutation.isPending}
                          className="block ml-auto mt-1 text-xs text-bambu-green hover:text-bambu-green/80 disabled:opacity-50"
                        >
                          {t('aito.retrySync')}
                        </button>
                      )}
                    </dd>
                  </div>
                )}

                {/* Also independent of the sync row above, and for the same
                    reason it had to be moved out of it: the sync row only
                    renders for pending/error/locked, and a card left declined
                    — restored from the trash, or re-imported from a declined
                    quote — is normally 'idle', so the one sentence explaining
                    why it is stuck rendered exactly never. */}
                {project.quote_status === 'declined' && (
                  <div className="flex items-baseline gap-2">
                    <dd className="ml-0 w-full text-xs text-bambu-gray">{t('aito.quoteDeclinedNoDraft')}</dd>
                  </div>
                )}

                {/* Rendered for ANY quote_sync_state, unlike the sync row
                    above: the reconciler records a block as a fact of its
                    own, and a card can be perfectly 'idle' for the line-item
                    sync while its STATUS is stuck against Books. */}
                {blockKey && (
                  <div className="flex items-baseline gap-2">
                    {/* No <dt>: the sync row above already uses the only label
                        that would fit ("Sync"), and two consecutive rows under
                        one identical term reads as a mistake. The sentence
                        names both sides itself, so it needs no term — it spans
                        the row instead. */}
                    <dd className="ml-0 w-full text-status-error">
                      {t(blockKey, {
                        ours: statusLabel(project.quote_status),
                        theirs: statusLabel(project.quote_status_remote),
                      })}
                    </dd>
                  </div>
                )}
              </dl>
                </PanelCard>
              )}

              <RecordCard project={project} latestEvent={latestEvent} />

              <ShippingCard project={project} currency={currency} />
            </div>

            <div
              data-testid="panel-column-tasks"
              className="min-w-0 lg:min-h-0 lg:overflow-y-auto scrollbar-hide px-5 py-4"
            >
              {/* Replaces TaskEditor's own "Tasks / Project total" heading
                  (suppressed below via `showHeader={false}`) — the money now
                  lives in the panel header, so repeating it here would be the
                  same total shown twice. `stepsDone`/`stepsTotal` are the
                  exact tally the panel header's own caption uses (see their
                  doc above): reusing the variables, not recomputing them,
                  is what keeps the two from ever disagreeing. */}
              <div className="flex items-center justify-between gap-4 mb-3">
                <p className="text-xs uppercase tracking-wide text-bambu-gray">{t('aito.workLabel')}</p>
                <div className="flex items-center gap-2 flex-1 max-w-[16rem]">
                  <div className="flex-1">
                    <ProjectProgress done={stepsDone} total={stepsTotal} testId="panel-work-progress" />
                  </div>
                  <span
                    data-testid="panel-work-steps-count"
                    className="flex-shrink-0 text-xs text-bambu-gray tabular-nums"
                  >
                    {t('aito.stepsCount', { done: stepsDone, total: stepsTotal })}
                  </span>
                </div>
              </div>
              <TaskEditor
                value={tasks}
                onChange={onTasksChange}
                onRemove={onRemoveTask}
                onRowBlur={(task) => {
                  if (task.id !== null) onRowBlur(task.id);
                }}
                canTick={project.quote_status === 'accepted'}
                pendingUids={pendingTaskUids}
                showHeader={false}
              />
            </div>

            <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto scrollbar-hide px-5 py-4">
              <ActivityRail projectId={project.id} />
            </div>
          </div>
        </div>

        <div
          data-testid="panel-footer"
          // `bg-bambu-dark-secondary`, same as the header and every card: the
          // footer sits on the canvas as a surface too, not a darker recess
          // of it.
          className="flex-shrink-0 flex items-center gap-2 px-4 py-2 border-t border-bambu-dark-tertiary bg-bambu-dark-secondary"
        >
          {/* Destructive far left, safe actions far right — the two ends of the
              bar. This is what the header adjacency to Close cost us.
              `alwaysVisible`/`withLabel`: far from any dismiss control down
              here, an icon that only reveals itself on hover (the header's
              old behaviour, kept as the default for TaskRow's own delete
              control) would be invisible at rest — all three footer actions
              are permanent bordered buttons with a visible label. */}
          {onDelete && (
            <DeleteHoldButton
              onDelete={onDelete}
              label={t('aito.moveToTrash')}
              hint={t('aito.holdToDelete')}
              alwaysVisible
            />
          )}
          {/* Mark sent / Accept / Decline / Done sit at the far right, with
              the destructive action at the far left — the two ends of the bar.
              These are the transitions that MOVE the card off this column, so
              they belong with the panel's other commitments rather than buried
              under the left rail's reference cards, where they sat below the
              fold on a project with several tasks.
              Done is the last of them and comes last on the bar: it is the
              transition the panel is open FOR at that point — you ticked the
              final step here — and until now it existed only on the board card
              behind you, so finishing a project meant closing the panel and
              finding the card again. The two blocks are mutually exclusive by
              construction (see ProjectDoneAction), so this never crowds. */}
          <span className="flex-1" />
          <QuoteStatusActions project={project} layout="row" />
          <ProjectDoneAction project={project} />
        </div>
      </div>
    </div>
  );
}
