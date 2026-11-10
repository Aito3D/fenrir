import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OrderActionResult, OrderBoardResponse, OrderBoardRow, OrderEditLine, OrderInvoiceScope } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { isRefused } from './orderErrors';

const BOARD_KEY = ['order-board'] as const;

type Callbacks<R, V> = { onSuccess?: (result: R, variables: V) => void; onError?: (error: unknown) => void };
type HandOverVars = { id: string; packageId: string; mode: 'pickup' | 'delivery'; applyCredit: boolean };
type InvoiceVars = { id: string; applyCredit: boolean; scope?: OrderInvoiceScope };

const HANDOVER_KEY = ['order-hand-over'] as const;

/** True while a hand-over of this order is in flight (from any component). */
export function useHandOverPending(orderId: string): boolean {
  return useIsMutating({ mutationKey: HANDOVER_KEY, predicate: m => (m.state.variables as { id?: string } | undefined)?.id === orderId }) > 0;
}

/** The write actions of an order: start a picklist, box its parcel, hand it over, invoice it, email an invoice, cancel it, print the prep sheet.
 *  Each answer carries the fresh board, which goes straight into the list; the
 *  finished orders are refetched. A failure is thrown to the caller, which words it.
 *  The callbacks run from the mutation itself, so they still fire after the caller unmounted. */
export function useOrderActions(callbacks?: {
  parcel?: Callbacks<{ package_number: string }, unknown>;
  picklist?: Callbacks<{ picklist: { id: string; number: string } }, unknown>;
  edit?: Callbacks<{ row: OrderBoardRow | null }, unknown>;
  parcelEdit?: Callbacks<{ row: OrderBoardRow | null }, unknown>;
  handOver?: Callbacks<OrderActionResult, HandOverVars>;
  invoice?: Callbacks<OrderActionResult, InvoiceVars>;
  cancel?: Callbacks<void, string>;
}) {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();

  const take = async (board: OrderBoardResponse) => {
    // A poll already in flight would land after this answer and put the old board back.
    await queryClient.cancelQueries({ queryKey: BOARD_KEY, exact: true });
    queryClient.setQueryData(BOARD_KEY, board);
    void queryClient.invalidateQueries({ queryKey: [...BOARD_KEY, 'finished'], exact: true });
    void queryClient.invalidateQueries({ queryKey: ['order-board-finished-order'] });
  };

  // What a hand-over preview showed is stale once the order was written, or refused because it moved.
  const dropPreviews = (id: string) => {
    queryClient.removeQueries({ queryKey: ['order-handover', id] });
    queryClient.removeQueries({ queryKey: ['order-invoice', id] });
  };
  const refused = (id: string, e: unknown) => {
    if (!isRefused(e)) return;
    dropPreviews(id);
    void queryClient.invalidateQueries({ queryKey: BOARD_KEY, exact: true });
  };

  const createParcel = useMutation({
    mutationFn: ({ id, picklistId, lines }: { id: string; picklistId: string; lines: { line_id: string; quantity: number }[] }) => api.createOrderParcel(id, picklistId, lines),
    // Here, not in mutate(): these still run when the panel closed meanwhile.
    onSuccess: async (r, v) => {
      await take(r.board);
      dropPreviews(v.id);
      callbacks?.parcel?.onSuccess?.(r, undefined);
    },
    onError: (e, v) => {
      refused(v.id, e);
      callbacks?.parcel?.onError?.(e);
    },
  });
  const createPicklist = useMutation({
    mutationFn: ({ id, lines }: { id: string; lines: { line_id: string; quantity: number }[] }) => api.createOrderPicklist(id, lines),
    onSuccess: async r => {
      await take(r.board);
      callbacks?.picklist?.onSuccess?.(r, undefined);
    },
    onError: (e, v) => {
      refused(v.id, e);
      callbacks?.picklist?.onError?.(e);
    },
  });
  const dropPackages = (id: string) => queryClient.removeQueries({ queryKey: ['order-package', id] });
  const editLines = useMutation({
    mutationFn: ({ id, version, lines }: { id: string; version: string; lines: OrderEditLine[] }) => api.updateOrderLines(id, { version, lines }),
    onSuccess: async (r, v) => {
      await take(r.board);
      dropPreviews(v.id);
      dropPackages(v.id);
      callbacks?.edit?.onSuccess?.(r, undefined);
    },
    onError: (e, v) => {
      refused(v.id, e);
      callbacks?.edit?.onError?.(e);
    },
  });
  const editParcel = useMutation({
    mutationFn: ({ id, packageId, version, was, lines }: { id: string; packageId: string; version: string; was: { line_id: string; quantity: number }[]; lines: { line_id: string; quantity: number }[] }) =>
      api.updateOrderPackage(id, packageId, { version, was, lines }),
    onSuccess: async (r, v) => {
      await take(r.board);
      dropPreviews(v.id);
      dropPackages(v.id);
      callbacks?.parcelEdit?.onSuccess?.(r, undefined);
    },
    onError: (e, v) => {
      refused(v.id, e);
      callbacks?.parcelEdit?.onError?.(e);
    },
  });
  const handOver = useMutation({
    mutationKey: HANDOVER_KEY,
    mutationFn: ({ id, packageId, mode, applyCredit }: HandOverVars) => api.handOverOrderParcel(id, packageId, { mode, apply_credit: applyCredit }),
    onSuccess: async (r, v) => {
      await take(r.board);
      dropPreviews(v.id);
      callbacks?.handOver?.onSuccess?.(r, v);
    },
    onError: (e, v) => {
      refused(v.id, e);
      callbacks?.handOver?.onError?.(e);
    },
  });
  const createInvoice = useMutation({
    mutationFn: ({ id, applyCredit, scope }: InvoiceVars) => api.createOrderInvoice(id, { apply_credit: applyCredit, scope }),
    onSuccess: async (r, v) => {
      await take(r.board);
      dropPreviews(v.id);
      callbacks?.invoice?.onSuccess?.(r, v);
    },
    onError: (e, v) => {
      refused(v.id, e);
      callbacks?.invoice?.onError?.(e);
    },
  });

  const cancelOrder = useMutation({
    mutationFn: (id: string) => api.cancelOrder(id),
    onSuccess: async (r, id) => {
      await take(r.board);
      dropPreviews(id);
      callbacks?.cancel?.onSuccess?.(undefined, id);
    },
    onError: (e, id) => {
      refused(id, e);
      callbacks?.cancel?.onError?.(e);
    },
  });

  // Books marks an emailed draft invoice sent, so the answer carries the board like every other write.
  const emailInvoice = useMutation({
    mutationFn: ({ invoiceId, to }: { invoiceId: string; to: string }) => api.sendOrderInvoiceEmail(invoiceId, to),
    onSuccess: r => take(r.board),
  });

  return {
    canUpdate: hasPermission('orders:update'),
    cancelOrder,
    createParcel,
    createPicklist,
    editLines,
    editParcel,
    handOver,
    createInvoice,
    emailInvoice,
    /** The blob fetcher for a print button; the server stamps the order as printed, so the board is refetched once it ran. */
    printSheet: (id: string, picklistId: string) => async () => {
      const blob = await api.printOrderPrepSheet(id, picklistId);
      void queryClient.invalidateQueries({ queryKey: BOARD_KEY, exact: true });
      return blob;
    },
  };
}
