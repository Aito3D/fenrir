import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { OrderActionResult, OrderBoardResponse } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';

const BOARD_KEY = ['order-board'] as const;

type Callbacks<R, V> = { onSuccess?: (result: R, variables: V) => void; onError?: (error: unknown) => void };
type HandOverVars = { id: string; packageId: string; mode: 'pickup' | 'delivery'; applyCredit: boolean };
type InvoiceVars = { id: string; applyCredit: boolean };

/** The write actions of an order: box a parcel, hand it over, invoice it, print the prep sheet.
 *  Each answer carries the fresh board, which goes straight into the list; the
 *  finished orders are refetched. A failure is thrown to the caller, which words it.
 *  The callbacks run from the mutation itself, so they still fire after the caller unmounted. */
export function useOrderActions(callbacks?: {
  parcel?: Callbacks<{ package_number: string }, unknown>;
  handOver?: Callbacks<OrderActionResult, HandOverVars>;
  invoice?: Callbacks<OrderActionResult, InvoiceVars>;
}) {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();

  const take = (board: OrderBoardResponse) => {
    queryClient.setQueryData(BOARD_KEY, board);
    void queryClient.invalidateQueries({ queryKey: [...BOARD_KEY, 'finished'], exact: true });
    void queryClient.invalidateQueries({ queryKey: ['order-board-finished-order'] });
  };

  const createParcel = useMutation({
    mutationFn: ({ id, lines }: { id: string; lines: { line_id: string; quantity: number }[] }) => api.createOrderParcel(id, lines),
    // Here, not in mutate(): these still run when the panel closed meanwhile.
    onSuccess: r => {
      take(r.board);
      callbacks?.parcel?.onSuccess?.(r, undefined);
    },
    onError: e => callbacks?.parcel?.onError?.(e),
  });
  const handOver = useMutation({
    mutationFn: ({ id, packageId, mode, applyCredit }: HandOverVars) => api.handOverOrderParcel(id, packageId, { mode, apply_credit: applyCredit }),
    onSuccess: (r, v) => {
      take(r.board);
      callbacks?.handOver?.onSuccess?.(r, v);
    },
    onError: e => callbacks?.handOver?.onError?.(e),
  });
  const createInvoice = useMutation({
    mutationFn: ({ id, applyCredit }: InvoiceVars) => api.createOrderInvoice(id, { apply_credit: applyCredit }),
    onSuccess: (r, v) => {
      take(r.board);
      callbacks?.invoice?.onSuccess?.(r, v);
    },
    onError: e => callbacks?.invoice?.onError?.(e),
  });

  return {
    canUpdate: hasPermission('orders:update'),
    createParcel,
    handOver,
    createInvoice,
    /** The blob fetcher for a print button; the server stamps the order as printed, so the board is refetched once it ran. */
    printSheet: (id: string) => async () => {
      const blob = await api.printOrderPrepSheet(id);
      void queryClient.invalidateQueries({ queryKey: BOARD_KEY, exact: true });
      return blob;
    },
  };
}
