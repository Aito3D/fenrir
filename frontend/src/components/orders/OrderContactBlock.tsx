import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CheckCircle2, Copy, Mail, MailX, MessageSquareText, Phone, PhoneOff, Smartphone, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OrderContact } from '../../api/client';
import { copyTextToClipboard } from '../../utils/clipboard';
import { Card } from '../Card';

/** The contact person on the order: phone and email as links, each with a copy button.
 *  With `sms` (admins, live orders with something ready) the header carries the pickup-SMS pill,
 *  which turns into "Contacted" once an SMS went out. */
export function OrderContactBlock({
  contact,
  orderNumber,
  others,
  onGoto,
  sms,
}: {
  contact: OrderContact | null;
  orderNumber: string;
  others: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  sms?: { contacted: { at: string; by: string } | null; onOpen: (phone: string) => void };
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
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
        className="rounded p-1 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
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
        {sms && contactedAt && (
          <button
            type="button"
            onClick={() => smsPhone && sms.onOpen(smsPhone)}
            disabled={!smsPhone}
            title={t('orders.sms.contactedBy', {
              by: sms.contacted?.by || '–',
              date: contactedAt.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
            })}
            className={`${pill} ml-auto border-green-400/30 bg-green-400/[0.14] text-green-400 hover:bg-green-400/25 focus-visible:ring-green-400/40`}
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
      {contact ? (
        <>
          <div className="mt-2 text-sm text-white">{contact.name}</div>
          <div className="mt-1 text-sm">
            {mobile && row(Smartphone, mobile, tel(mobile))}
            {phone && row(Phone, phone, tel(phone))}
            {!mobile && !phone && missing(PhoneOff, t('orders.contact.noPhone'))}
            {email
              ? row(Mail, email, `mailto:${email}?subject=${encodeURIComponent(t('orders.contact.mailSubject', { number: orderNumber }))}`)
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
