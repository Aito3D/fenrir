import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Plus, RotateCcw, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { AiSummaryPanel } from './AiSummaryPanel';
import { ClientSection } from './ClientSection';
import { CreateChecklist } from './CreateChecklist';
import { HoldButton } from './HoldButton';
import { NewContactForm } from './NewContactForm';
import { TaskEditor } from './TaskEditor';
import { AITO_SERVICE_LABEL_KEYS } from './services';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { useCurrency } from '../../hooks/useCurrency';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useNewProjectDraft } from '../../hooks/useNewProjectDraft';
import { buildFallbackSummary, tasksSignature } from '../../utils/aitoSummary';
import { defaultClientDraft, draftFromContact, formatPhone, visibleClientDraftErrors } from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import { visibleShippingDraftErrors } from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';
import {
  emptyTaskDraft,
  hasPricedService,
  projectHasPricedService,
  projectTotal,
  // The identity a row's blur-reveal is recorded under, shared with TaskEditor —
  // `onRowBlur` hands back the task, not the key, so both must agree on the same
  // function or a revealed row would never be recognised as revealed.
  rowKey,
  taskTotal,
} from '../../utils/taskDraft';
import type { TaskDraft } from '../../utils/taskDraft';

export interface NewProjectDrawerProps {
  onClose: () => void;
  onCreate: (description: string, draft: ClientDraft, tasks: TaskDraft[], shipping: ShippingDraft | null) => void;
}

type SectionId = 'work' | 'client';

/** A numbered, collapsible step of the drawer's main column: number-or-✓,
 *  title, a one-line hint, and a chevron. The number is `aria-hidden` so the
 *  header's accessible name reads "The work — 1 of 2 complete" rather than
 *  leading with a bare digit. */
function Section({
  index,
  title,
  hint,
  hintTone,
  open,
  done,
  onToggle,
  testId,
  children,
}: {
  index: number;
  title: string;
  hint: string;
  hintTone: 'neutral' | 'ok' | 'warn';
  open: boolean;
  done: boolean;
  onToggle: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex-shrink-0 overflow-hidden rounded-[.6rem] border border-bambu-dark-tertiary">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={onToggle}
        className={`flex w-full items-center gap-3 bg-white/[0.015] px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.035] ${focusRingCls}`}
      >
        <span
          aria-hidden="true"
          className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-colors duration-300 motion-reduce:transition-none ${
            done ? 'border-bambu-green bg-bambu-green text-white' : 'border-bambu-dark-tertiary text-bambu-gray'
          }`}
        >
          {done ? <Check className="h-3.5 w-3.5 animate-tick-in" /> : index}
        </span>
        <span className="flex-shrink-0 whitespace-nowrap text-sm font-semibold text-white">{title}</span>
        <span
          className={`min-w-0 flex-1 truncate text-xs ${
            hintTone === 'ok' ? 'text-bambu-green-light' : hintTone === 'warn' ? 'text-amber-400' : 'text-bambu-gray'
          }`}
        >
          {hint}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 flex-shrink-0 text-bambu-gray transition-transform duration-200 motion-reduce:transition-none ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {/* Mounted whether open or not, so the collapse can animate height both
          ways (a grid row interpolating 1fr↔0fr) instead of the body
          teleporting away. `inert` is what keeps the closed state honest:
          height 0 hides the fields but alone would leave them in Tab order. */}
      <div
        inert={!open}
        className={`grid motion-reduce:transition-none ${
          open
            ? 'grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity] duration-[250ms] ease-[var(--ease-signature)]'
            : 'grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-200 ease-[var(--ease-exit)]'
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-bambu-dark-tertiary p-3.5">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** The new-project workbench: a full-height drawer over the board, work first
 *  and client last, with a rail carrying the receipt, the AI summary, the
 *  "before you create" checklist and the actions.
 *
 *  Three rules govern the interaction, and each one is why a piece of state
 *  here exists rather than inside a child:
 *
 *  - **Nothing is lost by closing.** There is no Cancel: the whole draft is
 *    mirrored into `localStorage` (`useNewProjectDraft`) on every change, so ✕,
 *    Escape and a backdrop click all just hide the drawer. Wiping it takes a
 *    deliberate 0.5s hold on ↺.
 *  - **The summary is generated, not typed.** `summaryText`/`summaryEdited`
 *    live here (they persist with the draft); `AiSummaryPanel` only renders
 *    them and asks for a regeneration when `generateNonce` bumps — which
 *    happens on opening the Client section with a task signature the last
 *    summary didn't describe.
 *  - **Errors are revealed, never thrown.** A rule only names its offender
 *    once the user has left the surface it belongs to (`revealedTaskKeys`,
 *    `clientRevealed`), or once they have asked to create. That is why Create
 *    is `aria-disabled` rather than `disabled`: a disabled button swallows the
 *    click, and the click is exactly what reveals why it is disabled. */
export function NewProjectDrawer({ onClose, onCreate }: NewProjectDrawerProps) {
  const { t } = useTranslation();
  const persistence = useNewProjectDraft();
  const [tasks, setTasks] = useState<TaskDraft[]>(() => persistence.initial?.tasks ?? [emptyTaskDraft()]);
  const [draft, setDraft] = useState<ClientDraft | null>(() => persistence.initial?.client ?? null);
  const [summaryText, setSummaryText] = useState(() => persistence.initial?.summaryText ?? '');
  const [summaryEdited, setSummaryEdited] = useState(() => persistence.initial?.summaryEdited ?? false);
  const summarySignatureRef = useRef(persistence.initial?.summarySignature ?? '');
  const [generateNonce, setGenerateNonce] = useState(0);
  const [shipping, setShipping] = useState<ShippingDraft | null>(() => persistence.initial?.shipping ?? null);
  const [openSections, setOpenSections] = useState<Set<SectionId>>(() => new Set<SectionId>(['work']));
  const [revealedTaskKeys, setRevealedTaskKeys] = useState<Set<string>>(() => new Set());
  const [clientRevealed, setClientRevealed] = useState(false);
  const [creatingClient, setCreatingClient] = useState(false);

  const currency = useCurrency();

  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });
  // Same query ClientSection runs (identical key), so React Query dedupes
  // this onto its one request — this is only here so the rail receipt, the
  // client-section hint suffix and the checklist can show the island's LABEL
  // without any of them fetching on their own.
  const shippingServicesQuery = useQuery({
    queryKey: ['aito-shipping-services'],
    queryFn: api.getAitoShippingServices,
    staleTime: 60 * 60_000,
  });
  // Falls back to the raw island KEY, never '': while the catalogue hasn't
  // resolved yet (or never does) an empty label would render the rail as
  // "✈ " with a bare price and the checklist as "Shipping to  · <name>" — a
  // gap where the surface should degrade to something readable instead.
  const shippingIslandLabel = shipping
    ? (shippingServicesQuery.data?.services
        .flatMap((service) => service.islands)
        .find((island) => island.key === shipping.island)?.label ?? shipping.island)
    : '';
  const defaultId = statusQuery.data?.default_contact_id ?? '';
  const defaultName = statusQuery.data?.default_contact_name ?? '';
  // The status endpoint always returns a default contact — even a fallback one
  // — so it can ride along without a second round trip once Zoho *is*
  // configured. That default must never be treated as permission to create:
  // while `configured` is false there is no real client behind that id.
  const configured = statusQuery.data?.configured === true;

  // Seed the draft once the default contact is known. Also re-seeds after a
  // reset, which deliberately sets `draft` back to null.
  useEffect(() => {
    if (!draft && defaultId) setDraft(defaultClientDraft(defaultId, defaultName));
  }, [draft, defaultId, defaultName]);

  // Escape and a backdrop click are both "dismiss the thing on top": while the
  // create-client sub-form is showing that means stepping back to the client
  // section (same as its Back button), never discarding whatever the user
  // typed into it. Only when no sub-form is showing do they close the drawer —
  // which loses nothing, since the draft is persisted. Passed to the hook as
  // `onEscape`; reused verbatim for the backdrop's `onMouseDown` below.
  const dismiss = (requestClose: () => void) => {
    if (creatingClient) setCreatingClient(false);
    else requestClose();
  };

  const {
    closing,
    requestClose,
    dialogRef: panelRef,
  } = useDismissableDialog(onClose, { animationMs: 220, onEscape: dismiss });

  // Persist on every meaningful change. Section open-states and the reveal
  // sets are deliberately absent: they are about this visit, not the draft.
  useEffect(() => {
    persistence.save({
      tasks,
      client: draft,
      summaryText,
      summaryEdited,
      summarySignature: summarySignatureRef.current,
      shipping,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, draft, summaryText, summaryEdited, shipping]);

  const toggleSection = (id: SectionId) =>
    setOpenSections((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Opening the Client section is the signal that task entry is finished, so
  // it — and only it — triggers the one summarize call. Re-opening with the
  // same signature spends nothing; a hand-edited summary is never overwritten
  // (the panel's own latch honours `edited`, and this skips the bump anyway so
  // the nonce doesn't drift).
  const openClient = () => {
    const opening = !openSections.has('client');
    toggleSection('client');
    if (!opening) return;
    const signature = tasksSignature(tasks);
    if (!summaryEdited && signature !== summarySignatureRef.current) {
      summarySignatureRef.current = signature;
      setGenerateNonce((n) => n + 1);
    }
  };

  const resetDraft = () => {
    persistence.clear();
    setTasks([emptyTaskDraft()]);
    setDraft(null); // re-seeded by the default-contact effect above
    setSummaryText('');
    setSummaryEdited(false);
    // Cleared, so the next Client visit sees a stale signature and asks for a
    // fresh summary. The NONCE is deliberately left where it is: it is a
    // monotonic ticket, not a counter of this draft's generations.
    // `AiSummaryPanel` outlives the reset (nothing here unmounts it) and
    // dedupes on its own high-water mark, so rewinding the nonce to 0 would
    // make the next bump land on a number the panel had already seen and it
    // would silently ignore the request — the reset would quietly cost the
    // user their AI summary for the rest of the session.
    summarySignatureRef.current = '';
    setRevealedTaskKeys(new Set());
    setClientRevealed(false);
    setCreatingClient(false);
    setShipping(null);
  };

  const taskName = (task: TaskDraft, index: number) => task.title.trim() || t('aito.taskFallbackName', { n: index + 1 });

  const pricedCount = tasks.filter(hasPricedService).length;
  const hasUnpriced = pricedCount < tasks.length;
  const allPriced = projectHasPricedService(tasks);
  const revealedUnpricedIndex = tasks.findIndex(
    (task) => !hasPricedService(task) && revealedTaskKeys.has(rowKey(task)),
  );
  const revealedUnpricedName =
    revealedUnpricedIndex === -1 ? null : taskName(tasks[revealedUnpricedIndex], revealedUnpricedIndex);

  const phone = draft ? formatPhone({ countryCode: draft.countryCode, nationalNumber: draft.nationalNumber }) : '';
  const email = draft?.email.trim() ?? '';
  const clientReachable = phone !== '' || email !== '';
  // `visibleClientDraftErrors` only reports blurred fields, so this is what the
  // user can currently see — and gating on exactly that (not on raw validity)
  // matters: a contact whose *stored* phone or email is already malformed must
  // never disable Create before the user has touched anything, with no message
  // on screen explaining why. Clicking Create is what reveals it.
  const visibleErrors = draft ? visibleClientDraftErrors(draft) : { phone: null, email: null };
  const clientValid = draft === null || (visibleErrors.phone === null && visibleErrors.email === null);
  // Visible, not raw: a shipment the user has started but not finished must
  // not disable Create with nothing on screen saying why. Clicking Create is
  // what blurs every field (revealEverything) and turns the checklist line
  // amber, and only then does this go false.
  const shippingValid =
    shipping === null || Object.values(visibleShippingDraftErrors(shipping)).every((error) => error === null);
  const canCreate =
    tasks.length > 0
    && projectHasPricedService(tasks)
    && clientReachable
    && clientValid
    && configured
    && shippingValid;

  const summaryState = summaryText.trim() !== '' ? 'ready' : generateNonce > 0 ? 'generating' : 'waiting';

  const revealEverything = () => {
    setRevealedTaskKeys(new Set(tasks.map(rowKey)));
    setClientRevealed(true);
    // The same reveal the old modal's submit did: fields the user never left
    // start reporting their errors.
    if (draft) setDraft({ ...draft, blurred: { phone: true, email: true } });
    if (shipping) {
      setShipping({ ...shipping, blurred: { island: true, firstName: true, lastName: true, phone: true } });
    }
  };

  const create = () => {
    if (!canCreate || !draft) {
      revealEverything();
      return;
    }
    // `canCreate` is computed from what is VISIBLE, and a contact can arrive
    // from the directory already carrying a malformed phone or email that the
    // user never blurred — no message on screen, nothing disabled. Asking to
    // create is the moment those fields count as left, so reveal them and then
    // re-check on the revealed draft, exactly as the old modal's `submit` did.
    // Skipping this half is how a bad number reaches Zoho silently.
    const revealed = { ...draft, blurred: { phone: true, email: true } };
    setDraft(revealed);
    const revealedErrors = visibleClientDraftErrors(revealed);
    if (revealedErrors.phone !== null || revealedErrors.email !== null) return;

    // Same discipline for the shipment: a field never left (island picked via
    // one atomic action, but the phone pre-filled from the client and never
    // touched) must still be checked before the request goes out, or an
    // incomplete shipment could reach the server unnoticed.
    let revealedShipping = shipping;
    if (shipping) {
      revealedShipping = { ...shipping, blurred: { island: true, firstName: true, lastName: true, phone: true } };
      setShipping(revealedShipping);
      const shippingErrors = visibleShippingDraftErrors(revealedShipping);
      if (Object.values(shippingErrors).some((error) => error !== null)) return;
    }

    // The description is never empty: an unreachable or unconfigured AI leaves
    // the panel showing a fallback enumeration, and even that is rebuilt here
    // rather than trusting the panel to have run at all.
    const serviceLabel = (id: string) => t(AITO_SERVICE_LABEL_KEYS[id] ?? id);
    onCreate(summaryText.trim() || buildFallbackSummary(tasks, serviceLabel), draft, tasks, revealedShipping);
  };

  const onClientCreated = (contact: ZohoContact) => {
    setDraft(draftFromContact(contact, defaultId));
    setCreatingClient(false);
  };

  return (
    <div
      // pointer-events-none while closing: the drawer is already spoken for,
      // and a click landing under it mid-exit would hit the board.
      className={`fixed inset-0 z-50 bg-black/60 ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss(requestClose);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.modalTitle')}
        tabIndex={-1}
        className={`${closing ? 'animate-drawer-out' : 'animate-drawer-in'} fixed inset-y-0 right-0 z-50 flex w-full max-w-[1100px] flex-col border-l border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-[-30px_0_60px_rgba(0,0,0,0.5)] focus:outline-none`}
      >
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-bambu-dark-tertiary px-4 py-3">
          <h2 className="text-base font-semibold text-white">{t('aito.modalTitle')}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            // Not `dismiss`: ✕ closes the drawer even from the create-client
            // sub-form, where Escape/backdrop only step back.
            onClick={requestClose}
            className={`-m-1 ml-auto rounded-md p-1 text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_288px]">
          <div className="flex flex-col gap-3 overflow-y-auto border-r border-bambu-dark-tertiary p-4 scrollbar-hide">
            <Section
              index={1}
              testId="drawer-section-work"
              title={t('aito.workSection')}
              hint={
                tasks.length === 0
                  ? t('aito.workHintNone')
                  : t('aito.workHintProgress', { done: pricedCount, total: tasks.length })
              }
              hintTone={allPriced ? 'ok' : 'neutral'}
              open={openSections.has('work')}
              done={allPriced}
              onToggle={() => toggleSection('work')}
            >
              <TaskEditor
                value={tasks}
                onChange={setTasks}
                onRemove={(index) => setTasks(tasks.filter((_, i) => i !== index))}
                // Zero tasks is a visible checklist error, not a hard floor:
                // being told "no" after the fact beats a ✕ that silently
                // refuses to work.
                minRows={0}
                // A project being created has no quote, so no step of it can be
                // authorised work yet.
                canTick={false}
                // The rail's receipt already carries the project total.
                showHeader={false}
                // One task open at a time: a quote's worth of drafts should
                // scan as a list of headers, not a wall of forms.
                accordion
                onRowBlur={(task) => setRevealedTaskKeys((prev) => new Set(prev).add(rowKey(task)))}
              />
            </Section>

            <Section
              index={2}
              testId="drawer-section-client"
              title={t('aito.clientSectionTitle')}
              hint={
                clientReachable
                  ? `${draft?.name ?? ''} · ${phone || email}${
                      shipping && shippingIslandLabel ? ` · ✈ ${shippingIslandLabel}` : ''
                    }`
                  : t('aito.ruleClientContact')
              }
              hintTone={clientReachable ? 'ok' : 'warn'}
              open={openSections.has('client')}
              done={clientReachable && clientValid}
              onToggle={openClient}
            >
              {creatingClient ? (
                <NewContactForm onCancel={() => setCreatingClient(false)} onCreated={onClientCreated} />
              ) : draft ? (
                <div
                  // Replays on the way back from the create-client form (the
                  // ternary swaps element types, so this remounts): the
                  // returning section rises in just as the form did.
                  className="animate-rise"
                  onBlur={(e) => {
                    // focusout bubbles in React, so one handler covers every
                    // field; relatedTarget inside means the user is still in
                    // the section and there is nothing to reveal yet. Same
                    // idiom as `TaskRow`'s own blur containment check.
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setClientRevealed(true);
                  }}
                >
                  <ClientSection
                    value={draft}
                    onChange={setDraft}
                    onCreateNew={() => setCreatingClient(true)}
                    defaultContactId={defaultId}
                    defaultContactName={defaultName}
                    shipping={shipping}
                    onShippingChange={setShipping}
                  />
                  {/* Soft, never blocking: one channel is enough to create the
                      project, but the missing one has a real consequence. */}
                  {phone !== '' && email === '' && (
                    <p className="mt-2 text-xs text-amber-400">{t('aito.warnNoEmail')}</p>
                  )}
                  {email !== '' && phone === '' && (
                    <p className="mt-2 text-xs text-amber-400">{t('aito.warnNoPhone')}</p>
                  )}
                </div>
              ) : null}
            </Section>
          </div>

          <div className="flex flex-col gap-4 overflow-y-auto bg-bambu-dark p-4 scrollbar-hide">
            <div>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-bambu-gray">
                {t('aito.railSummary')}
              </div>
              <div className="space-y-1.5 text-sm">
                {tasks.map((task, index) => (
                  <div key={rowKey(task)} className="flex justify-between gap-2">
                    <span className="truncate text-bambu-gray-light">{taskName(task, index)}</span>
                    {hasPricedService(task) ? (
                      <Money currency={currency} value={taskTotal(task)} className="flex-shrink-0 text-white" />
                    ) : (
                      // The em dash is the receipt's version of the checklist's
                      // "needs a sub-task" line; the title spells that out for
                      // anyone who meets the dash first.
                      <span title={t('aito.taskNeedsSubTask')} className="flex-shrink-0 text-amber-400">
                        —
                      </span>
                    )}
                  </div>
                ))}
                {shipping && shipping.price !== null && (
                  <div data-testid="rail-shipping-row" className="flex justify-between gap-2 text-sky-400">
                    <span className="truncate">✈ {shippingIslandLabel}</span>
                    <Money currency={currency} value={shipping.price} className="flex-shrink-0" />
                  </div>
                )}
                <div className="flex justify-between gap-2">
                  <span className="truncate text-bambu-gray-light">{t('aito.client')}</span>
                  <span className="truncate text-white">{draft?.name ?? t('aito.noClient')}</span>
                </div>
                <div
                  data-testid="rail-project-total"
                  className="mt-1 flex justify-between gap-2 border-t border-bambu-dark-tertiary pt-2"
                >
                  <span className="font-semibold text-white">{t('aito.projectTotal')}</span>
                  <Money
                    currency={currency}
                    value={projectTotal(tasks) + (shipping?.price ?? 0)}
                    className="flex-shrink-0 font-bold text-bambu-green-light"
                  />
                </div>
              </div>
            </div>

            <AiSummaryPanel
              tasks={tasks}
              value={summaryText}
              edited={summaryEdited}
              generateNonce={generateNonce}
              onChange={(text, edited) => {
                setSummaryText(text);
                setSummaryEdited(edited);
              }}
            />

            {/* Wrapped for scoping, not styling: the client section's header
                hint says the same "needs a phone or an email" this checklist
                does, so a test (or a screen reader user scanning the rail)
                needs the two to be distinguishable. */}
            <div data-testid="drawer-checklist">
              <CreateChecklist
                taskCount={tasks.length}
                revealedUnpricedName={revealedUnpricedName}
                hasUnpriced={hasUnpriced}
                summaryState={summaryState}
                clientAccountName={draft?.name ?? t('aito.noClient')}
                clientReachable={clientReachable}
                clientContact={phone || email}
                clientRevealed={clientRevealed}
                shipping={shipping}
                shippingIslandLabel={shippingIslandLabel}
              />
            </div>

            <div className="mt-auto flex items-stretch gap-2">
              <HoldButton
                onHold={resetDraft}
                durationMs={500}
                progress="perimeter"
                label={t('aito.resetDraft')}
                hint={t('aito.holdToReset')}
                // Square and icon-only: destructive, so it stays a ghost until
                // touched rather than competing with Create beside it. Padding,
                // border and colour in full — `HoldButton`'s base supplies none
                // of them (see its doc).
                className={`w-9 flex-shrink-0 justify-center border border-bambu-dark-tertiary py-2 text-bambu-gray transition-colors hover:border-red-400/40 hover:text-red-400 data-[holding=true]:border-red-400 data-[holding=true]:text-red-400 ${focusRingCls}`}
              >
                <RotateCcw className="h-4 w-4" />
              </HoldButton>
              <button
                type="button"
                // Not `disabled`: a disabled button swallows the click, and the
                // click is what reveals the errors explaining the disabling.
                aria-disabled={!canCreate}
                onClick={create}
                className={`inline-flex flex-1 items-center justify-center gap-2 rounded-md bg-bambu-green px-4 py-2 text-sm font-semibold text-white transition-opacity ${focusRingCls} ${
                  canCreate ? 'hover:bg-bambu-green-light' : 'opacity-45'
                }`}
              >
                <Plus className="h-4 w-4" />
                {t('aito.create')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
