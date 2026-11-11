import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Send } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { inputCls, labelCls } from '../formStyles';
import { api, type OrderBoardResponse, type OrderPanelRow } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useToast } from '../../contexts/ToastContext';
import { SmsRelayError, sendThroughRelay, smsLength } from '../../utils/smsRelay';

/** A beat past .animate-modal-out's 150ms, as in the Aito SMS modal. */
const MODAL_OUT_MS = 170;

/** Draft, edit and send the pickup SMS of an order. The text comes from a fixed
 *  template on the server (instant, no AI); the page sends it through the relay
 *  on this Mac, then the server marks the order as contacted. */
export function OrderSmsModal({ row, phone, onClose }: { row: OrderPanelRow; phone: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [edited, setEdited] = useState(false);

  const draft = useQuery({
    queryKey: ['order-sms-draft', row.id],
    queryFn: () => api.getOrderSmsDraft(row.id),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // Seed the textarea from the draft until the user edits it (derived in render, no flash).
  if (draft.data && !edited && message !== draft.data.message) setMessage(draft.data.message);

  const send = useMutation({
    mutationFn: async () => {
      const text = message.trim();
      await sendThroughRelay(phone, text);
      // The payment link counts as sent only if the text that went out still holds it.
      const link = draft.data?.payment_link;
      const record = link && text.includes(link.url) ? api.recordOrderSms(row.id, link.id) : api.recordOrderSms(row.id);
      // The SMS is already out: a failed record only loses the contacted mark, and must not read as a
      // failed send (a retry would text the client twice).
      return record.catch(() => null);
    },
    onSuccess: (fresh) => {
      void queryClient.invalidateQueries({ queryKey: ['order-events', row.id] });
      if (fresh) {
        queryClient.setQueryData<OrderBoardResponse>(['order-board'], (board) =>
          board ? { ...board, rows: board.rows.map((r) => (r.id === fresh.id ? fresh : r)) } : board,
        );
        showToast(t('orders.sms.sent', { number: row.number }), 'success');
      } else {
        void queryClient.invalidateQueries({ queryKey: ['order-board'], exact: true });
        showToast(t('aito.smsSent'), 'success');
      }
      requestClose();
    },
    onError: (error: unknown) => {
      const outcome = error instanceof SmsRelayError ? error.outcome : 'failed';
      if (outcome === 'unreachable') showToast(t('aito.smsRelayUnreachable'), 'error');
      else if (outcome === 'maybe') showToast(t('aito.smsMaybeSent'), 'warning');
      else showToast(t('aito.smsSendFailed'), 'error');
    },
  });

  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, {
    animationMs: MODAL_OUT_MS,
    onEscape: (close) => {
      if (!send.isPending) close();
    },
  });

  const length = smsLength(message);
  const lengthLabel = t(length.gsm ? 'orders.sms.length' : 'orders.sms.lengthSpecial', {
    chars: length.chars,
    parts: length.parts,
  });

  return (
    <div
      className={`fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4 ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={send.isPending ? undefined : requestClose}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.smsTitle')}
        tabIndex={-1}
        className={`w-full max-w-lg focus:outline-none ${closing ? 'animate-modal-out' : 'animate-modal-in'}`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-6">
          <h3 className="mb-1 text-lg font-semibold text-white">
            {t('aito.smsTitle')} · <span className="font-mono">{row.number}</span>
          </h3>
          <p className="mb-4 text-sm text-bambu-gray">
            {row.contact?.name ? `${row.contact.name} · ` : ''}
            {phone}
          </p>

          {draft.isFetching && (
            <div className="flex items-center gap-2 py-6 text-sm text-bambu-gray">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('aito.smsGenerating')}
            </div>
          )}
          {draft.isError && !draft.isFetching && (
            <p className="py-6 text-sm text-status-error">{t('aito.smsGenerateFailed')}</p>
          )}
          {!draft.isFetching && !draft.isError && (
            <div className="animate-rise">
              <label className={labelCls} htmlFor="order-sms-message">
                {t('aito.smsMessageLabel')}
              </label>
              <textarea
                id="order-sms-message"
                className={`${inputCls} min-h-28 resize-y`}
                value={message}
                maxLength={1000}
                onChange={(e) => {
                  setEdited(true);
                  setMessage(e.target.value);
                }}
                disabled={send.isPending}
              />
              <p
                data-testid="order-sms-length"
                className={`mt-1 text-right text-xs tabular-nums ${length.parts > 1 || !length.gsm ? 'text-amber-400' : 'text-bambu-gray'}`}
              >
                {lengthLabel}
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={requestClose} disabled={send.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEdited(false);
                if (draft.data) setMessage(draft.data.message);
              }}
              disabled={!edited || send.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              {t('orders.sms.reset')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => send.mutate()}
              disabled={draft.isFetching || send.isPending || !message.trim()}
            >
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t('aito.smsSend')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
