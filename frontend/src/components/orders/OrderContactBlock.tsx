import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Copy, Mail, MailX, MessageSquareText, Pencil, Phone, PhoneOff, Smartphone, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderContact } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import { Card } from '../Card';
import { ClientRatingPill } from '../aito/ClientRatingPill';
import { OrderClientHistoryButton } from './OrderClientHistoryModal';
import { errorReason } from './orderErrors';
import { useOrderActions } from './useOrderActions';

/** The contact person on the order: phone and email as links, each with a copy button.
 *  With `sms` (admins, live orders with something ready) the header carries the pickup-SMS pill,
 *  which turns into "Contacted" once an SMS went out. With `orderId` it also shows the customer's
 *  payment rating (as on the Aito card); `canEdit` adds the email/phone editor. With `customerId` instead of `orderId`
 *  (a counter order not created yet) the rating and the editor go to the Books customer itself.
 *  `historyOf` (the order's Books customer) adds the History pill and its dialog of the client's orders. */
export function OrderContactBlock({
  contact,
  orderNumber,
  others,
  onGoto,
  sms,
  orderId,
  customerId,
  historyOf,
  canEdit = false,
}: {
  historyOf?: string;
  orderId?: string;
  customerId?: string;
  canEdit?: boolean;
  contact: OrderContact | null;
  orderNumber: string;
  others: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  sms?: { contacted: { at: string; by: string } | null; onOpen: (phone: string) => void };
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const rating = useQuery({
    queryKey: orderId ? ['order-customer', orderId, 'rating'] : ['aito-client-rating', customerId],
    queryFn: () => (orderId ? api.getOrderClientRating(orderId) : api.getAitoClientRating(customerId!)),
    enabled: !!(orderId || customerId),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [editing, setEditing] = useState(false);
  // The Contacted pill pops only when an SMS goes out while this order is open, never on mount.
  const contactedNow = !!sms?.contacted;
  const [seenContacted, setSeenContacted] = useState(contactedNow);
  const [pop, setPop] = useState(false);
  if (contactedNow !== seenContacted) {
    setSeenContacted(contactedNow);
    setPop(contactedNow);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (value: string) => {
    if (!(await copyTextToClipboard(value))) return;
    setCopied(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  };

  const clean = (v: string | undefined) => (v ?? '').trim();
  const mobile = clean(contact?.mobile);
  const phone = clean(contact?.phone);
  const email = clean(contact?.email);

  const row = (Icon: LucideIcon, value: string, href: string) => (
    <div key={value} className="flex items-center gap-2">
      <Icon aria-hidden="true" className="h-3.5 w-3.5 text-bambu-gray" />
      <a href={href} className="py-0.5 tabular-nums text-bambu-green hover:underline">{value}</a>
      <button
        type="button"
        aria-label={copied === value ? t('orders.contact.copied') : t('orders.contact.copy', { what: value })}
        onClick={() => copy(value)}
        className="btn-press rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
      >
        {copied === value ? <Check aria-hidden="true" className="animate-slice-done h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
  const missing = (Icon: LucideIcon, label: string) => (
    <div className="flex items-center gap-2 py-0.5 text-bambu-gray">
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </div>
  );
  const tel = (v: string) => `tel:${v.replace(/\s+/g, '')}`;
  const smsPhone = mobile || phone;
  const pill = 'inline-flex items-center gap-1 whitespace-nowrap rounded-[.4rem] border px-2 py-0.5 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2';
  const contactedAt = sms?.contacted ? new Date(sms.contacted.at) : null;

  return (
    <Card className="p-3 text-xs">
      <div className="flex items-center gap-2">
        <UserRound aria-hidden="true" className="h-3.5 w-3.5 text-bambu-gray" />
        <span className="font-semibold uppercase tracking-wide text-white">{t('orders.contact.title')}</span>
        <ClientRatingPill rating={rating.data} align="start" />
        {historyOf && contact && <OrderClientHistoryButton customerId={historyOf} name={contact.name} currentId={orderId} onGoto={onGoto} className={pill} />}
        {canEdit && (orderId || customerId) && contact && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={t('aito.clientEdit')}
            title={t('aito.clientEdit')}
            className="btn-press rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
          >
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
        {sms && contactedAt && (
          <button
            type="button"
            onClick={() => smsPhone && sms.onOpen(smsPhone)}
            disabled={!smsPhone}
            title={t('orders.sms.contactedBy', {
              by: sms.contacted?.by || '–',
              date: contactedAt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
            })}
            className={`${pill} ${pop ? 'animate-aito-pop-in' : ''} ml-auto border-green-400/30 bg-green-400/[0.14] text-green-400 hover:bg-green-400/25 focus-visible:ring-green-400/40`}
          >
            <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
            {t('aito.contacted')} · {contactedAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
          </button>
        )}
        {sms && !contactedAt && (
          <button
            type="button"
            onClick={() => smsPhone && sms.onOpen(smsPhone)}
            disabled={!smsPhone}
            aria-label={t('aito.smsPickup')}
            title={t(smsPhone ? 'aito.smsPickup' : 'aito.smsNoPhone')}
            className={`${pill} ml-auto ${
              smsPhone
                ? 'border-violet-400/30 bg-violet-400/[0.14] text-violet-400 hover:bg-violet-400/25 focus-visible:ring-violet-400/40'
                : 'cursor-not-allowed border-bambu-dark-tertiary bg-bambu-dark text-bambu-gray'
            }`}
          >
            <MessageSquareText aria-hidden="true" className="h-3.5 w-3.5" />
            {t('aito.smsPickupShort')}
          </button>
        )}
      </div>
      {contact && editing && (orderId || customerId) ? (
        <ContactEditor orderId={orderId} customerId={customerId} contact={contact} onDone={() => setEditing(false)} />
      ) : contact ? (
        <>
          <div className="mt-2 text-sm text-white">{contact.name}</div>
          <div className="mt-1 text-sm">
            {mobile && row(Smartphone, mobile, tel(mobile))}
            {phone && row(Phone, phone, tel(phone))}
            {!mobile && !phone && missing(PhoneOff, t('orders.contact.noPhone'))}
            {email
              ? row(Mail, email, orderNumber ? `mailto:${email}?subject=${encodeURIComponent(t('orders.contact.mailSubject', { number: orderNumber }))}` : `mailto:${email}`)
              : missing(MailX, t('orders.contact.noEmail'))}
          </div>
        </>
      ) : (
        <div className="mt-2 text-bambu-gray">{t('orders.contact.none')}</div>
      )}
      {others.length > 0 && (
        <div className="mt-2 border-t border-bambu-dark-tertiary pt-2 text-bambu-gray">
          {t('orders.contact.alsoOpen')}{' '}
          {others.map((o, i) => (
            <span key={o.id}>
              {i > 0 && ', '}
              <button type="button" onClick={() => onGoto?.(o.id)} className="font-mono text-bambu-green hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green">
                {o.number}
              </button>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

const INPUT = 'w-full rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-sm text-white focus:border-bambu-green focus:outline-none';

/** Email and phone of the order's contact person (or of the customer, before there is an order), written to Zoho
 *  Books. The number goes back to the field it came from. */
function ContactEditor({ orderId, customerId, contact, onDone }: { orderId?: string; customerId?: string; contact: OrderContact; onDone: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { editContact: editOrderContact } = useOrderActions();
  const editCustomer = useMutation({
    mutationFn: ({ id, ...body }: { id: string; email: string; phone: string; phone_field: 'phone' | 'mobile' }) => api.updateZohoContact(id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['zoho-contact', customerId] }),
  });
  const editContact = orderId ? editOrderContact : editCustomer;
  const phoneField = contact.mobile.trim() || !contact.phone.trim() ? 'mobile' : 'phone';
  const [email, setEmail] = useState(contact.email);
  const [phone, setPhone] = useState(phoneField === 'mobile' ? contact.mobile : contact.phone);
  const save = (e: FormEvent) => {
    e.preventDefault();
    editContact.mutate(
      { id: orderId ?? customerId ?? '', email: email.trim(), phone: phone.trim(), phone_field: phoneField },
      { onSuccess: onDone, onError: e => showToast(errorReason(t, e) || t('aito.clientEditFailed'), 'error') },
    );
  };
  return (
    <form onSubmit={save} className="mt-2 space-y-2">
      <div className="text-sm text-white">{contact.name}</div>
      <label className="block">
        <span className="text-bambu-gray">{t('aito.clientPhone')}</span>
        <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} maxLength={50} className={INPUT} />
      </label>
      <label className="block">
        <span className="text-bambu-gray">{t('aito.clientEmail')}</span>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={200} className={INPUT} />
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} disabled={editContact.isPending} className="btn-press rounded-md px-2.5 py-1 text-bambu-gray hover:text-white">
          {t('common.cancel')}
        </button>
        <button type="submit" disabled={editContact.isPending} className="btn-press rounded-md bg-bambu-green px-2.5 py-1 font-semibold text-black hover:bg-bambu-green/90 disabled:opacity-50">
          {editContact.isPending ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  );
}
