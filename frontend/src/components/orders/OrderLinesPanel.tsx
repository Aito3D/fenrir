import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderPicklist, OrderPanelRow } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { HoldButton } from '../aito/HoldButton';
import { usePrintBlob } from '../aito/usePrintBlob';
import { errorReason, isRefused } from './orderErrors';
import { OrderLineRow } from './OrderLineRow';
import { OrderPackedActions, OrderPackedBars } from './OrderPackedBand';
import { OrderParcelEditRows } from './OrderParcelEditRows';
import { OrderPrepActions } from './OrderPrepActions';
import { OrderRefChips } from './OrderRefChips';
import { OrderSidePanel } from './OrderSidePanel';
import { OrderTodoCheckRow, OrderTodoEditRows } from './OrderTodoBand';
import { OrderWatchButton } from './OrderWatchButton';
import { boxablePicklists, canPick, editTotal, packableUnits, panelGroups, parseDay, startEdit, waitingPackages } from './orderBoard';
import type { OrderCheck, OrderEdit, PanelGroup, ParcelEdit } from './orderBoard';
import { EDIT_BTN, GROUP } from './orderLinesShared';
import { TONE } from './orderStatus';
import { useHandOverPending, useOrderActions } from './useOrderActions';
import { useOrderOutcomeToasts } from './useOrderOutcomeToasts';


/** The expanded order: one table, split into what is left to prepare, what is
 *  boxed and waiting, what has gone, and the lines that never ship. A group
 *  header is a tinted band, so it cannot be mistaken for a product row. */
export function OrderLinesPanel({
  row,
  others = [],
  onGoto,
  start,
  startTick,
  onHandoverOpen,
  onEdited,
}: {
  row: OrderPanelRow;
  others?: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  /** The step that opens, on mount and whenever `startTick` changes: 'pick', 'pack-<picklist id>' or 'handover-<package id>'. */
  start?: string;
  /** Changes with every click on the row icon, so a second click reopens a bar that was cancelled. */
  startTick?: number;
  /** Told when a hand-over bar opens or closes (and closed on unmount): the row icon hides meanwhile. */
  onHandoverOpen?: (open: boolean) => void;
  /** Told once an order edit was saved: the row flashes. */
  onEdited?: () => void;
}) {
  const { t } = useTranslation();
  const toasts = useOrderOutcomeToasts();
  const { showToast } = useToast();
  const { canUpdate, createInvoice, cancelOrder, printSheet } = useOrderActions({
    invoice: { onSuccess: r => toasts.outcome(r.outcome), onError: toasts.failed },
    cancel: { onSuccess: () => showToast(t('orders.cancel.done', { number: row.number })), onError: toasts.failed },
  });
  // The parcel whose hand-over bar is open.
  const [handover, setHandover] = useState<string | null>(null);
  // The pickup SMS: admins, on a live order with something ready (a finished order has nothing to collect).
  const { isAdmin, authEnabled } = useAuth();
  const smsAllowed = isAdmin && (row as { status?: string }).status !== 'finished' && row.ready_ratio > 0;
  // While a hand-over of this order is in flight, the bar on screen stays as it is.
  const handingOver = useHandOverPending(row.id);
  const pendingNow = useRef(handingOver);
  pendingNow.current = handingOver;
  // Set while the operator chooses the lines of a new picklist, or checks the parcel of one.
  const [checkState, setCheck] = useState<OrderCheck | null>(null);
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();
  const { print, busy: printing } = usePrintBlob({ failureMessage: t('orders.prep.printFailed'), downloadFilename: `${row.number}-prep.pdf` });
  // The check being loaded: what a picklist or its parcel may hold is asked from Zoho when the check opens.
  const [opening, setOpening] = useState<string | null>(null);
  // Whether a bar is open now, read after an await: a bar opened while Zoho answered wins, one bar at a time.
  const barOpen = useRef(false);
  const openCheck = async (picklist: OrderPicklist | null) => {
    setOpening(picklist?.id ?? 'pick');
    try {
      const { lines } = picklist ? await api.getOrderPicklist(row.id, picklist.id) : await api.getOrderPicklistPreview(row.id);
      if (barOpen.current) return;
      const max = Object.fromEntries(lines.map(l => [l.line_id, l.quantity]));
      if (!lines.length) showToast(t(picklist ? 'orders.pick.boxed' : 'orders.pick.nothing'), 'error');
      else setCheck({ kind: picklist ? 'pack' : 'pick', picklist: picklist ?? undefined, max, qty: { ...max } });
    } catch (e) {
      showToast(t(picklist ? 'orders.parcel.failed' : 'orders.pick.failed', { reason: errorReason(t, e) }), 'error');
      if (isRefused(e)) void queryClient.invalidateQueries({ queryKey: ['order-board'], exact: true });
    } finally {
      setOpening(null);
    }
  };
  // Set while the operator edits the order's lines.
  const [editState, setEdit] = useState<OrderEdit | null>(null);
  const [saving, setSaving] = useState(false);
  // Set while the operator edits a waiting parcel, opened from what Books holds for it now.
  const [parcelState, setParcel] = useState<ParcelEdit | null>(null);
  const [parcelBusy, setParcelBusy] = useState(false);
  // A saved parcel edit flashes the packed band once, the way a new invoice flashes in its card.
  const [parcelSaved, setParcelSaved] = useState(false);
  const openParcel = async (packageId: string) => {
    setOpening(`parcel-${packageId}`);
    try {
      const c = await api.getOrderPackage(row.id, packageId);
      if (barOpen.current) return;
      const was = Object.fromEntries(c.lines.filter(l => l.quantity > 0).map(l => [l.line_id, l.quantity]));
      const picklist = (row.picklists ?? []).find(p => p.id === c.picklist_id)?.number ?? c.picklist_id;
      setParcel({ packageId, number: c.number, picklist, version: c.version, pending: c.pending, was, max: Object.fromEntries(c.lines.map(l => [l.line_id, l.max])), qty: Object.fromEntries(c.lines.map(l => [l.line_id, l.quantity])) });
    } catch (e) {
      showToast(t('orders.parcelEdit.failed', { reason: errorReason(t, e) }), 'error');
      if (isRefused(e)) void queryClient.invalidateQueries({ queryKey: ['order-board'], exact: true });
    } finally {
      setOpening(null);
    }
  };
  const starter = useRef({ openCheck, row, checking: checkState !== null, editing: editState !== null || parcelState !== null });
  starter.current = { openCheck, row, checking: checkState !== null, editing: editState !== null || parcelState !== null };
  useEffect(() => {
    if (!start || !canUpdate || pendingNow.current || starter.current.editing) return; // an edit is open: one bar at a time
    const id = start.slice(start.indexOf('-') + 1);
    if (start.startsWith('handover-')) setHandover(id);
    else if (starter.current.checking) return; // a check is open: the row icon does not wipe what was typed
    else if (start === 'pick') void starter.current.openCheck(null);
    else {
      const picklist = (starter.current.row.picklists ?? []).find(p => p.id === id);
      if (picklist) void starter.current.openCheck(picklist);
    }
  }, [start, startTick, canUpdate]);
  const handoverOpen = !!handover && waitingPackages(row).some(p => p.id === handover);
  useEffect(() => {
    onHandoverOpen?.(handoverOpen);
    return () => onHandoverOpen?.(false);
  }, [handoverOpen, onHandoverOpen]);
  // A choice of what to pick only exists while the shelf holds something, the parcel check of a picklist while
  // units are left to box; a refetch that ends either closes it for good.
  const packable = checkState?.kind === 'pack' ? panelGroups(row).some(g => g.id === 'todo') : packableUnits(row) > 0;
  const check = checkState && packable ? checkState : null;
  const checkLabel = check ? (check.kind === 'pick' ? 'orders.pick.toPick' : 'orders.parcel.inParcel') : null;
  useEffect(() => {
    if (checkState && !packable) {
      setCheck(null);
      setPending(false);
    }
  }, [checkState, packable]);
  // A refetch that empties "to prepare" closes the edit for good.
  const hasTodo = panelGroups(row).some(g => g.id === 'todo');
  const edit = editState && hasTodo ? editState : null;
  useEffect(() => {
    if (editState && !hasTodo) {
      setEdit(null);
      setSaving(false);
    }
  }, [editState, hasTodo]);
  const closeEdit = () => { refocus.current = 'edit'; setEdit(null); setSaving(false); };
  // A refetch where the parcel is no longer waiting (handed over, deleted) closes its edit.
  const parcel = parcelState && waitingPackages(row).some(p => p.id === parcelState.packageId) ? parcelState : null;
  barOpen.current = !!edit || !!check || handoverOpen || !!parcel;
  useEffect(() => {
    if (parcelState && !parcel) {
      setParcel(null);
      setParcelBusy(false);
    }
  }, [parcelState, parcel]);
  const closeParcel = () => { if (parcel) refocus.current = `parcel-${parcel.packageId}`; setParcel(null); setParcelBusy(false); };
  const picklistOpen = (row.picklists ?? []).find(p => p.status !== 'completed');
  const editLead = canUpdate && !handoverOpen && !parcel ? (
    picklistOpen ? (
      <span title={t('orders.edit.lockedHint')} className="inline-flex items-center gap-1.5 text-[11px] text-bambu-gray">
        <Lock aria-hidden="true" className="h-3.5 w-3.5" />
        {t('orders.edit.locked', { number: picklistOpen.number })}
      </span>
    ) : (
      <button type="button" data-opens="edit" disabled={opening !== null} onClick={() => setEdit(startEdit(row))} className={EDIT_BTN}>
        <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
        {t('orders.edit.open')}
      </button>
    )
  ) : null;
  const itemIds = new Set([...row.lines.flatMap(l => (l.item_id ? [l.item_id] : [])), ...(edit?.added ?? []).map(a => a.item.id)]);
  const editQty = (id: string, v: number) => edit && setEdit({ ...edit, qty: { ...edit.qty, [id]: v } });
  const setGone = (id: string, gone: boolean) => {
    if (!edit) return;
    const next = new Set(edit.gone);
    if (gone) next.add(id);
    else next.delete(id);
    setEdit({ ...edit, gone: next });
  };
  const editingTotal = edit ? editTotal(row, edit) : null;
  // After a bar closes, focus goes back to the button that opened it (found again by `data-opens`).
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (!refocus.current) return;
    root.current?.querySelector<HTMLElement>(`[data-opens="${refocus.current}"]`)?.focus();
    refocus.current = null;
  });
  const shortDay = (day: string) => parseDay(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const chips = (group: PanelGroup['id']) =>
    row.packages
      .filter(p => (group === 'packed' ? p.status === 'not_shipped' : group === 'shipped' && p.status !== 'not_shipped'))
      .map(p => (
        <span
          key={p.number}
          className={`rounded-full border border-bambu-dark-tertiary bg-bambu-dark/40 px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal ${group === 'packed' ? TONE.info.text : 'text-bambu-gray'}`}
        >
          {t(p.status === 'not_shipped' ? 'orders.pkg.packed' : p.status === 'delivered' ? 'orders.pkg.delivered' : 'orders.pkg.shipped', {
            number: p.number,
            date: shortDay(p.date),
          })}
        </span>
      ));

  return (
    <div
      ref={root}
      onKeyDown={e => {
        if (e.key !== 'Escape') return;
        if (edit && !saving) closeEdit();
        if (parcel && !parcelBusy) closeParcel();
      }}
      className="animate-rise-sm grid gap-4 border-t border-bambu-dark-tertiary bg-bambu-dark/40 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_27rem]">
      <div className="order-last min-w-0 lg:order-none">
      <OrderRefChips row={row}>
        {/* A finished order rings no bell: nothing to watch for. */}
        {authEnabled && (row as { status?: string }).status !== 'finished' && <OrderWatchButton orderId={row.id} />}
        {canUpdate && (
          <HoldButton
            onHold={() => cancelOrder.mutate(row.id)}
            disabled={cancelOrder.isPending}
            durationMs={1000}
            label={t('orders.cancel.label')}
            hint={t('orders.cancel.hint')}
            progress="bar"
            className="border border-bambu-dark-tertiary px-2.5 py-1 text-xs text-bambu-gray hover:border-red-400/45 hover:text-red-400 focus-visible:ring-red-400/40 data-[holding=true]:border-red-400 data-[holding=true]:text-red-400"
          >
            <Trash2 aria-hidden="true" className="relative h-3.5 w-3.5 text-red-400" />
            <span className="relative">{t('orders.cancel.label')}</span>
          </HoldButton>
        )}
      </OrderRefChips>
      <div
        role="region"
        tabIndex={0}
        aria-label={t('orders.col.product')}
        className="overflow-x-auto overscroll-contain lg:max-h-[70vh] lg:overflow-y-auto"
      >
        <table className="w-full min-w-[35rem] text-sm">
          <thead className="bg-bambu-dark text-left lg:sticky lg:top-0 lg:z-10 text-[11px] uppercase tracking-wide text-bambu-gray">
            <tr>
              <th className="py-1.5 font-medium">{t('orders.col.product')}</th>
              <th className="text-right font-medium">{t(edit ? 'orders.edit.ordered' : parcel ? 'orders.parcelEdit.inParcel' : (checkLabel ?? 'orders.col.qty'))}</th>
              <th className="pl-4 text-right font-medium">{t('orders.col.available')}</th>
              <th className="pl-4 text-right font-medium">{t('orders.col.short')}</th>
              <th className="pl-4 font-medium">{edit ? '' : t('orders.col.state')}</th>
            </tr>
          </thead>
          {panelGroups(row).map(group => {
            const meta = GROUP[group.id];
            const Icon = meta.icon;
            return (
              <tbody key={group.id} className={meta.dim ? 'opacity-60' : ''}>
                <tr>
                  <th role="rowheader" colSpan={5} className="pt-3 pb-1 text-left font-normal">
                    <div
                      data-fresh={(group.id === 'packed' && parcelSaved) || undefined}
                      onAnimationEnd={e => { if (e.target === e.currentTarget) setParcelSaved(false); }}
                      className={`flex flex-wrap items-center gap-2 rounded-md px-3 py-1.5 text-xs ${meta.band} ${group.id === 'packed' && parcelSaved ? 'motion-safe:animate-[pulse_1s_ease-in-out_2]' : ''} ${(group.id === 'todo' && edit) || (group.id === 'packed' && parcel) ? `ring-1 ${edit ? 'ring-bambu-green/40' : 'ring-blue-400/40'}` : ''}`}
                    >
                      <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${meta.name}`} />
                      <span className={`font-semibold uppercase tracking-wide ${meta.name}`}>{t(meta.label)}</span>
                      {group.units !== null && (
                        <span className="rounded-full bg-bambu-dark/60 px-2 py-0.5 text-[11px] tabular-nums text-bambu-gray">
                          {t('orders.units', { count: group.units })}
                        </span>
                      )}
                      {chips(group.id)}
                      {group.id === 'packed' && canUpdate && !handoverOpen && !edit && !parcel && (
                        <OrderPackedActions row={row} showEdit={!check} opening={opening} onOpenParcel={id => void openParcel(id)} onHandover={setHandover} />
                      )}
                      {group.id === 'todo' && !check && !edit && !parcel && !handoverOpen && (editLead || canPick(row) || boxablePicklists(row).length > 0) && (
                        <OrderPrepActions
                          row={row}
                          lead={editLead}
                          opening={opening}
                          printing={printing}
                          onPick={() => void openCheck(null)}
                          onPack={p => void openCheck(p)}
                          onPrint={p => void print(printSheet(row.id, p.id))}
                        />
                      )}
                    </div>
                  </th>
                </tr>
                {group.id === 'packed' && parcel ? (
                  <OrderParcelEditRows
                    lines={group.lines.map(l => l.line)}
                    all={row.lines}
                    parcel={parcel}
                    busy={parcelBusy}
                    onQty={(id, v) => setParcel({ ...parcel, qty: { ...parcel.qty, [id]: v } })}
                  />
                ) : group.lines.map(({ line, qty, ofQty }, index) => (
                  <OrderLineRow
                    key={line.id}
                    groupId={group.id}
                    line={line}
                    qty={qty}
                    ofQty={ofQty}
                    index={index}
                    edit={edit}
                    check={check}
                    checkLabel={checkLabel}
                    saving={saving}
                    pending={pending}
                    editQty={editQty}
                    setGone={setGone}
                    setCheck={setCheck}
                  />
                ))}
                {group.id === 'packed' && (
                  <OrderPackedBars
                    row={row}
                    parcel={parcel}
                    handover={handoverOpen ? handover : null}
                    onParcelClose={closeParcel}
                    onParcelBusy={setParcelBusy}
                    onParcelSaved={() => setParcelSaved(true)}
                    onHandoverClose={() => { refocus.current = `handover-${handover}`; setHandover(null); }}
                  />
                )}
                {group.id === 'todo' && edit && (
                  <OrderTodoEditRows row={row} edit={edit} itemIds={itemIds} saving={saving} setEdit={setEdit} onClose={closeEdit} onBusy={setSaving} onSaved={onEdited} />
                )}
                {group.id === 'todo' && check && (
                  <OrderTodoCheckRow
                    row={row}
                    check={check}
                    onClose={() => { refocus.current = check.picklist ? `pack-${check.picklist.id}` : 'pick'; setCheck(null); setPending(false); }}
                    onBusy={setPending}
                    onPicked={p => void print(printSheet(row.id, p.id))}
                  />
                )}
              </tbody>
            );
          })}
        </table>
      </div>
      </div>
      <OrderSidePanel
        row={row}
        others={others}
        onGoto={onGoto}
        canUpdate={canUpdate}
        createInvoice={createInvoice}
        smsAllowed={smsAllowed}
        editingTotal={editingTotal}
      />
    </div>
  );
}
