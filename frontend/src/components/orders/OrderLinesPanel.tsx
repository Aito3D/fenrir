import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, CheckCheck, ClipboardList, HandHelping, Loader2, Lock, Package, Pencil, ReceiptText, Trash2, Undo2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderBoardLine, OrderPanelRow, OrderPicklist } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { HoldButton } from '../aito/HoldButton';
import { PanelTabs } from '../aito/PanelTabs';
import { panelTabId, panelTabPanelId } from '../aito/panelTabIds';
import { usePanelTab } from '../../hooks/usePanelTab';
import { OrderActivity } from './OrderActivity';
import { usePrintBlob } from '../aito/usePrintBlob';
import { errorReason, isRefused } from './orderErrors';
import { OrderContactBlock } from './OrderContactBlock';
import { OrderSmsModal } from './OrderSmsModal';
import { OrderEditBar } from './OrderEditBar';
import { OrderHandoverBar } from './OrderHandoverBar';
import { OrderInvoicesBlock } from './OrderInvoicesBlock';
import { OrderItemSearch } from './OrderItemSearch';
import { OrderPackBar } from './OrderPackBar';
import { OrderParcelEditBar } from './OrderParcelEditBar';
import { OrderParcelEditRows } from './OrderParcelEditRows';
import { OrderPaymentBlock } from './OrderPaymentBlock';
import { OrderPrepActions } from './OrderPrepActions';
import { OrderQtyStepper } from './OrderQtyStepper';
import { OrderRefChips } from './OrderRefChips';
import { boxablePicklists, canPick, editTotal, formatQty, packableUnits, panelGroups, parseDay, startEdit, waitingPackages } from './orderBoard';
import type { OrderCheck, OrderEdit, PanelGroup, ParcelEdit } from './orderBoard';
import { formatMoney } from '../../utils/pricing';
import { FIT_VIEWPORT, TONE } from './orderStatus';
import type { Tone } from './orderStatus';
import { useHandOverPending, useOrderActions } from './useOrderActions';
import { useOrderOutcomeToasts } from './useOrderOutcomeToasts';

const SIDE_TABS = ['details', 'activity'] as const;

const GROUP: Record<PanelGroup['id'], { label: string; icon: LucideIcon; tone: Tone; band: string; name: string; dim: boolean }> = {
  todo: { label: 'orders.group.todo', icon: ClipboardList, tone: 'neutral', band: 'bg-bambu-green/10', name: 'text-white', dim: false },
  packed: { label: 'orders.group.packed', icon: Package, tone: 'info', band: TONE.info.soft, name: TONE.info.text, dim: false },
  shipped: { label: 'orders.group.shipped', icon: CheckCheck, tone: 'neutral', band: TONE.neutral.soft, name: 'text-bambu-gray', dim: true },
  other: { label: 'orders.group.other', icon: ReceiptText, tone: 'neutral', band: TONE.neutral.soft, name: 'text-bambu-gray', dim: true },
};

const LINE_STATE: Record<OrderBoardLine['state'], { label: string; cls: string }> = {
  ready: { label: 'orders.line.ready', cls: TONE.success.text },
  backorder: { label: 'orders.line.backorder', cls: TONE.warning.text },
  to_order: { label: 'orders.line.toOrder', cls: TONE.danger.text },
  shipped: { label: 'orders.line.shipped', cls: 'text-bambu-gray' },
  cancelled: { label: 'orders.line.cancelled', cls: 'text-bambu-gray' },
  service: { label: 'orders.line.service', cls: 'text-bambu-gray' },
};

const dash = <span className="text-bambu-gray">–</span>;
const EDIT_BTN = 'inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2.5 py-1 text-xs text-white hover:border-bambu-green hover:text-bambu-green disabled:opacity-50';
const TRASH = 'grid h-7 w-7 place-items-center rounded-md text-bambu-gray hover:bg-red-500/15 hover:text-red-400 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-bambu-gray';

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
}) {
  const { t } = useTranslation();
  const [sideTab, setSideTab] = usePanelTab(SIDE_TABS, 'orders.panel.tab');
  const tabScope = `order-${row.id}-`;
  const toasts = useOrderOutcomeToasts();
  const { showToast } = useToast();
  const { canUpdate, createInvoice, cancelOrder, printSheet } = useOrderActions({
    invoice: { onSuccess: r => toasts.outcome(r.outcome), onError: toasts.failed },
    cancel: { onSuccess: () => showToast(t('orders.cancel.done', { number: row.number })), onError: toasts.failed },
  });
  // The parcel whose hand-over bar is open.
  const [handover, setHandover] = useState<string | null>(null);
  // The pickup SMS: admins, on a live order with something ready (a finished order has nothing to collect).
  const { isAdmin } = useAuth();
  const smsAllowed = isAdmin && (row as { status?: string }).status !== 'finished' && row.ready_ratio > 0;
  const [smsPhone, setSmsPhone] = useState<string | null>(null);
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
  const invoiceSent = useRef(false);
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
                    <div className={`flex flex-wrap items-center gap-2 rounded-md px-3 py-1.5 text-xs ${meta.band} ${(group.id === 'todo' && edit) || (group.id === 'packed' && parcel) ? `ring-1 ${edit ? 'ring-bambu-green/40' : 'ring-blue-400/40'}` : ''}`}>
                      <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${meta.name}`} />
                      <span className={`font-semibold uppercase tracking-wide ${meta.name}`}>{t(meta.label)}</span>
                      {group.units !== null && (
                        <span className="rounded-full bg-bambu-dark/60 px-2 py-0.5 text-[11px] tabular-nums text-bambu-gray">
                          {t('orders.units', { count: group.units })}
                        </span>
                      )}
                      {chips(group.id)}
                      {group.id === 'packed' && canUpdate && !handoverOpen && !edit && !parcel && (
                        <span className={`flex basis-full flex-wrap items-center gap-2 lg:ml-auto lg:basis-auto ${FIT_VIEWPORT}`}>
                          {waitingPackages(row).map((p, _i, all) => (
                            <span key={p.id} className="contents">
                            {!check && (
                              <button
                                type="button"
                                data-opens={`parcel-${p.id}`}
                                disabled={opening !== null}
                                onClick={() => void openParcel(p.id)}
                                className={EDIT_BTN}
                              >
                                {opening === `parcel-${p.id}` ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Pencil aria-hidden="true" className="h-3.5 w-3.5" />}
                                {all.length > 1 ? t('orders.parcelEdit.openNumber', { number: p.number }) : t('orders.parcelEdit.open')}
                              </button>
                            )}
                            <button
                              type="button"
                              data-opens={`handover-${p.id}`}
                              onClick={() => setHandover(p.id)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2.5 py-1 text-xs text-white hover:border-blue-400 hover:text-blue-400"
                            >
                              <HandHelping aria-hidden="true" className="h-3.5 w-3.5" />
                              {all.length > 1 ? t('orders.handover.openNumber', { number: p.number }) : t('orders.handover.open')}
                            </button>
                            </span>
                          ))}
                        </span>
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
                ) : group.lines.map(({ line, qty, ofQty }, index) => {
                  const todo = group.id === 'todo';
                  const short = todo && (line.state === 'backorder' || line.state === 'to_order');
                  const editing = todo && edit;
                  const gone = !!edit && todo && edit.gone.has(line.id);
                  return (
                    <tr key={line.id} className={`${index ? 'border-t border-bambu-dark-tertiary/60' : ''} ${(todo && check && !(check.max[line.id] > 0)) || gone ? 'opacity-40' : ''}`}>
                      <td className={`border-l-2 py-2 pl-4 pr-3 ${TONE[meta.tone].rail} ${gone ? 'line-through' : ''}`}>
                        <div className="text-white">{line.name}</div>
                        {line.sku && <div className="font-mono text-xs text-bambu-gray">{line.sku}</div>}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums text-white">
                        {editing && gone ? (
                          <span className="line-through">{formatQty(line.quantity)}</span>
                        ) : editing ? (
                          <>
                            <OrderQtyStepper
                              id={line.id}
                              name={line.name}
                              label={t('orders.edit.ordered')}
                              value={edit.qty[line.id] ?? line.quantity}
                              min={line.floor}
                              positive // removing a line is the trash's job, never a 0
                              checkbox={false}
                              disabled={saving}
                              onChange={v => editQty(line.id, v)}
                            />
                            {line.floor > 0 && (
                              <span title={t('orders.edit.cannotRemove')} className="ml-1.5 text-[10px] text-bambu-gray">{t('orders.edit.min', { n: formatQty(line.floor) })}</span>
                            )}
                          </>
                        ) : todo && check && checkLabel && check.max[line.id] > 0 ? (
                          <OrderQtyStepper
                            id={line.id}
                            name={line.name}
                            label={t(checkLabel)}
                            value={Math.min(check.qty[line.id] ?? 0, check.max[line.id])}
                            max={check.max[line.id]}
                            disabled={pending}
                            onChange={v => setCheck({ ...check, qty: { ...check.qty, [line.id]: v } })}
                          />
                        ) : (
                          formatQty(qty)
                        )}
                        {ofQty !== null && !editing && <span className="ml-1 text-xs text-bambu-gray">{t('orders.ofOrdered', { n: formatQty(ofQty) })}</span>}
                        {todo && line.invoiced > 0 && (
                          <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] ${TONE.info.soft} ${TONE.info.text}`}>{t('orders.line.invoiced')}</span>
                        )}
                      </td>
                      <td className={`text-right tabular-nums ${todo && line.state === 'ready' ? TONE.success.text : 'text-white'}`}>
                        {todo && line.stock_available !== null ? formatQty(line.stock_available) : dash}
                      </td>
                      <td className={`text-right tabular-nums ${short ? LINE_STATE[line.state].cls : ''}`}>
                        {short ? <>−{formatQty(line.shortfall)}</> : dash}
                      </td>
                      {editing ? (
                        <td className="whitespace-nowrap pl-4">
                          {gone ? (
                            <button type="button" disabled={saving} onClick={() => setGone(line.id, false)} className="inline-flex items-center gap-1 text-xs text-bambu-gray hover:text-white disabled:opacity-50">
                              <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
                              {t('orders.edit.restore')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              aria-label={`${t('orders.edit.remove')} · ${line.name}`}
                              title={t(line.floor > 0 ? 'orders.edit.cannotRemove' : 'orders.edit.remove')}
                              disabled={saving || line.floor > 0}
                              onClick={() => setGone(line.id, true)}
                              className={TRASH}
                            >
                              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      ) : (
                      <td className="whitespace-nowrap pl-4">
                        {group.id === 'packed' && (
                          <span className={`inline-flex items-center gap-1 ${TONE.info.text}`}>
                            <Package aria-hidden="true" className="h-3.5 w-3.5" />
                            {t('orders.line.packed')}
                          </span>
                        )}
                        {group.id === 'shipped' && (
                          <span className="inline-flex items-center gap-1 text-bambu-gray">
                            <Check aria-hidden="true" className="h-3.5 w-3.5" />
                            {t('orders.line.shipped')}
                          </span>
                        )}
                        {(todo || group.id === 'other') && <span className={LINE_STATE[line.state].cls}>{t(LINE_STATE[line.state].label)}</span>}
                        {todo && line.covered_by_po > 0 && (
                          <span className="ml-1.5 text-xs text-bambu-gray">
                            {line.po_numbers.join(', ')} · +{formatQty(line.covered_by_po)}
                          </span>
                        )}
                      </td>
                      )}
                    </tr>
                  );
                })}
                {group.id === 'packed' && parcel && (
                  <tr>
                    <td colSpan={5} className="pt-2 animate-rise-sm">
                      <OrderParcelEditBar row={row} parcel={parcel} onClose={closeParcel} onBusy={setParcelBusy} />
                    </td>
                  </tr>
                )}
                {group.id === 'packed' && handoverOpen && handover && (
                  <tr>
                    <td colSpan={5} className="pt-2 animate-rise-sm">
                      <OrderHandoverBar key={handover} row={row} packageId={handover} onClose={() => { refocus.current = `handover-${handover}`; setHandover(null); }} />
                    </td>
                  </tr>
                )}
                {group.id === 'todo' && edit && (
                  <>
                    {edit.added.map(({ item, quantity }) => (
                      <tr key={`add-${item.id}`} className="border-t border-bambu-dark-tertiary/60">
                        <td className="border-l-2 border-bambu-green py-2 pl-4 pr-3">
                          <div className="text-white">{item.name}</div>
                          {item.sku && <div className="font-mono text-xs text-bambu-gray">{item.sku}</div>}
                          <span className="mt-0.5 inline-block rounded bg-bambu-green/15 px-1.5 py-0.5 text-[10px] text-bambu-green">
                            {t('orders.edit.newLine', { price: formatMoney(item.rate, row.currency) })}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-right tabular-nums text-white">
                          <OrderQtyStepper
                            id={`add-${item.id}`}
                            name={item.name}
                            label={t('orders.edit.ordered')}
                            value={quantity}
                            positive
                            checkbox={false}
                            disabled={saving}
                            onChange={v => setEdit({ ...edit, added: edit.added.map(a => (a.item.id === item.id ? { ...a, quantity: v } : a)) })}
                          />
                        </td>
                        <td className="text-right tabular-nums text-white">{item.stock_on_hand !== null ? formatQty(item.stock_on_hand) : dash}</td>
                        <td className="text-right">{dash}</td>
                        <td className="pl-4">
                          <button
                            type="button"
                            aria-label={`${t('orders.edit.remove')} · ${item.name}`}
                            title={t('orders.edit.remove')}
                            disabled={saving}
                            onClick={() => setEdit({ ...edit, added: edit.added.filter(a => a.item.id !== item.id) })}
                            className={TRASH}
                          >
                            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t border-bambu-dark-tertiary/60">
                      <td colSpan={5} className="py-2 pl-4">
                        <OrderItemSearch
                          orderItemIds={itemIds}
                          currency={row.currency}
                          disabled={saving}
                          onAdd={item => setEdit({ ...edit, added: [...edit.added, { item, quantity: 1 }] })}
                        />
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={5} className="pt-2 animate-rise-sm">
                        <OrderEditBar row={row} edit={edit} onClose={closeEdit} onBusy={setSaving} />
                      </td>
                    </tr>
                  </>
                )}
                {group.id === 'todo' && check && (
                  <tr>
                    <td colSpan={5} className="pt-2 animate-rise-sm">
                      <OrderPackBar
                        row={row}
                        check={check}
                        onClose={() => { refocus.current = check.picklist ? `pack-${check.picklist.id}` : 'pick'; setCheck(null); setPending(false); }}
                        onBusy={setPending}
                        onPicked={p => void print(printSheet(row.id, p.id))}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
      </div>
      <div className="min-w-0 lg:self-start">
        <PanelTabs
          tabs={[
            { id: 'details', label: t('aito.panelTabDetails') },
            { id: 'activity', label: t('aito.history.title') },
          ]}
          selected={sideTab}
          onSelect={setSideTab}
          attentionLabel={t('aito.panelTabAttention')}
          scope={tabScope}
        />
        {/* Only the selected panel mounts, so the history query never runs behind a closed tab. */}
        <div role="tabpanel" id={panelTabPanelId(sideTab, tabScope)} aria-labelledby={panelTabId(sideTab, tabScope)}>
          {sideTab === 'details' ? (
            <div className="space-y-3">
              <OrderContactBlock
                contact={row.contact}
                orderNumber={row.number}
                others={others}
                onGoto={onGoto}
                sms={smsAllowed ? { contacted: row.contacted ?? null, onOpen: setSmsPhone } : undefined}
              />
              {smsPhone && <OrderSmsModal row={row} phone={smsPhone} onClose={() => setSmsPhone(null)} />}
              {row.payment && <OrderPaymentBlock payment={row.payment} currency={row.currency} total={editingTotal ?? undefined} quoteNumber={row.facts.quote_number} />}
              <OrderInvoicesBlock
                row={row}
                canEmail={canUpdate}
                busy={createInvoice.isPending}
                onCreateInvoice={canUpdate ? () => {
                  if (createInvoice.isPending || invoiceSent.current) return;
                  invoiceSent.current = true;
                  createInvoice.mutate({ id: row.id, applyCredit: (row.payment?.advance ?? 0) + (row.payment?.retainer ?? 0) > 0 }, { onSettled: () => { invoiceSent.current = false; } });
                } : undefined}
                onInvoiceNow={canUpdate ? (scope, applyCredit) => {
                  if (createInvoice.isPending || invoiceSent.current) return;
                  invoiceSent.current = true;
                  createInvoice.mutate({ id: row.id, applyCredit, scope }, { onSettled: () => { invoiceSent.current = false; } });
                } : undefined}
              />
            </div>
          ) : (
            <OrderActivity soId={row.id} currency={row.currency} />
          )}
        </div>
      </div>
    </div>
  );
}
