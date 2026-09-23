import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight, Plane, RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoTask, ZohoContact } from '../../api/client';
import { ClientCombobox } from './ClientCombobox';
import { ClientHistory } from './ClientHistory';
import { ContactPersonPicker } from './ContactPersonPicker';
import { useClientRating } from './useClientRating';
import { ClientRatingPill } from './ClientRatingPill';
import { PhoneInput } from './PhoneInput';
import { SocialInput } from './SocialInput';
import { FieldError } from './FieldError';
import { ShippingFields } from './ShippingFields';
import {
  visibleClientDraftErrors,
  applyContactPerson,
  defaultClientDraft,
  draftFromContact,
  parsePhone,
} from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import { emptyShippingDraft } from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';
import { useCurrency } from '../../hooks/useCurrency';
import { focusRingCls, inputCls, inputErrorCls, labelCls } from '../formStyles';

export interface ClientSectionProps {
  value: ClientDraft;
  onChange: (next: ClientDraft) => void;
  onCreateNew: () => void;
  defaultContactId: string;
  defaultContactName: string;
  shipping: ShippingDraft | null;
  onShippingChange: (next: ShippingDraft | null) => void;
  /** Reuse from the recall block: the drawer appends these as fresh rows. */
  onReuseTasks: (tasks: AitoTask[]) => void;
  /** For the company branch: the person to pre-select (recalled from the
   *  client's latest card). `undefined` while the recall is still loading,
   *  so the picker waits rather than picking the primary too early. */
  preferredPersonId: string | null | undefined;
}

/** The client half of the Aito new-project form: who the client is, the phone
 *  and email that will be written back to Zoho, the social handle that never
 *  leaves the card (see `ClientDraft.socialNetwork`'s own doc), and the
 *  shipment.
 *
 *  Reset visibility keys off `touched`, never a value diff — a contact stored
 *  as a bare `89645864` re-formats to `+689-89645864`, so a value test would
 *  light up controls on fields nobody edited. */
export function ClientSection({
  value,
  onChange,
  onCreateNew,
  defaultContactId,
  defaultContactName,
  shipping,
  onShippingChange,
  onReuseTasks,
  preferredPersonId,
}: ClientSectionProps) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });
  const servicesQuery = useQuery({
    queryKey: ['aito-shipping-services'],
    queryFn: api.getAitoShippingServices,
    // The island table is app data and the rates change at most daily. One
    // request per session is the point of the server-side cache.
    staleTime: 60 * 60_000,
  });
  // Empty id for the walk-in default: the hook disables itself, and the
  // backend would answer `new` for it anyway.
  const rating = useClientRating(value.isDefault ? '' : value.id);

  // Company branch bookkeeping, keyed by client id so a client switch resets
  // it: whether Books listed anybody (hides the plain inputs behind the
  // override), whether the list could not be read (notice + plain inputs),
  // and whether the operator opened the override.
  const [personsState, setPersonsState] = useState<{ id: string; has: boolean | null; failed: boolean }>({
    id: value.id, has: null, failed: false,
  });
  const [overrideOpen, setOverrideOpen] = useState(false);
  useEffect(() => {
    setPersonsState({ id: value.id, has: null, failed: false });
    setOverrideOpen(false);
  }, [value.id]);
  const companyBranch = value.isCompany && !value.isDefault;
  const listed = companyBranch && personsState.id === value.id && personsState.has === true;
  const listFailed = companyBranch && personsState.id === value.id && personsState.failed;

  if (statusQuery.data?.configured === false) {
    return (
      <div>
        <label className={labelCls}>{t('aito.client')}</label>
        <div className="p-3 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-sm text-bambu-gray">
          {t('aito.zohoNotConfigured')}{' '}
          <Link to="/settings?tab=zoho" className="text-bambu-green hover:underline">
            {t('aito.zohoConfigureLink')}
          </Link>
        </div>
      </div>
    );
  }

  const selectContact = (contact: ZohoContact) => onChange(draftFromContact(contact, defaultContactId));

  // Reverting returns the field to its quiet initial state: the stored value
  // back, and both flags cleared so any error message disappears with it.
  const revertPhone = () => {
    const parsed = parsePhone(value.original.phone);
    onChange({
      ...value,
      countryCode: parsed.countryCode,
      nationalNumber: parsed.nationalNumber,
      touched: { ...value.touched, phone: false },
      blurred: { ...value.blurred, phone: false },
    });
  };

  const revertEmail = () =>
    onChange({
      ...value,
      email: value.original.email,
      touched: { ...value.touched, email: false },
      blurred: { ...value.blurred, email: false },
    });

  const errors = visibleClientDraftErrors(value);

  const resetButtonCls = (visible: boolean) =>
    `p-2 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-opacity ${focusRingCls} ${
      visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
    }`;

  // Extracted so the company branch can wrap it in the collapsed override
  // disclosure below instead of rendering it inline — same fields, same
  // handlers, just a different place in the tree.
  const contactInputs = (
    <>
      <div>
        <label htmlFor="aito-client-phone" className={labelCls}>
          {t('aito.clientPhone')}
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <PhoneInput
              id="aito-client-phone"
              countryCode={value.countryCode}
              nationalNumber={value.nationalNumber}
              invalid={errors.phone !== null}
              // PhoneInput fires onChange(stripped) and onBlur(stripped) back to
              // back in the same native blur event. Both must land in a single
              // onChange here — issuing two, each spreading the same stale
              // pre-blur `value`, would let the second call's incomplete draft
              // clobber the first call's digit-stripping.
              onBlur={(next) =>
                onChange({
                  ...value,
                  countryCode: next.countryCode,
                  nationalNumber: next.nationalNumber,
                  blurred: { ...value.blurred, phone: true },
                })
              }
              onChange={(next, changed) =>
                onChange({
                  ...value,
                  countryCode: next.countryCode,
                  nationalNumber: next.nationalNumber,
                  touched: { ...value.touched, phone: true },
                  // A country-code pick is one atomic action, so its error (if
                  // any) should be visible right away — unlike a national-number
                  // keystroke, which stays quiet until the field is blurred.
                  blurred: changed === 'countryCode' ? { ...value.blurred, phone: true } : value.blurred,
                })
              }
            />
          </div>
          <button
            type="button"
            aria-label={t('aito.revertPhone')}
            title={t('aito.revertPhone')}
            onClick={revertPhone}
            className={resetButtonCls(value.touched.phone)}
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
        <FieldError messageKey={errors.phone} />
      </div>

      <div>
        <label htmlFor="aito-client-email" className={labelCls}>
          {t('aito.clientEmail')}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="aito-client-email"
            type="email"
            autoComplete="off"
            value={value.email}
            onChange={(e) => onChange({ ...value, email: e.target.value, touched: { ...value.touched, email: true } })}
            onBlur={() => onChange({ ...value, blurred: { ...value.blurred, email: true } })}
            placeholder={t('aito.emailPlaceholder')}
            aria-invalid={errors.email !== null ? true : undefined}
            className={errors.email !== null ? inputErrorCls : inputCls}
          />
          <button
            type="button"
            aria-label={t('aito.revertEmail')}
            title={t('aito.revertEmail')}
            onClick={revertEmail}
            className={resetButtonCls(value.touched.email)}
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
        <FieldError messageKey={errors.email} />
      </div>
    </>
  );

  return (
    <div className="space-y-3">
      <ClientCombobox
        clientName={value.name}
        onSelect={selectContact}
        onCreateNew={onCreateNew}
        onReset={() => onChange(defaultClientDraft(defaultContactId, defaultContactName))}
        showReset={value.id !== defaultContactId}
        trailing={<ClientRatingPill rating={rating.data} />}
      />

      <ClientHistory clientId={value.id} isDefault={value.isDefault} onReuse={onReuseTasks} />

      {companyBranch && (
        <ContactPersonPicker
          contactId={value.id}
          value={value.contactPersonId}
          preferredId={preferredPersonId}
          onSelect={(person) => onChange(applyContactPerson(value, person))}
          onLoaded={(has) => setPersonsState({ id: value.id, has, failed: false })}
          onUnavailable={() => setPersonsState({ id: value.id, has: false, failed: true })}
          variant="drawer"
        />
      )}
      {listFailed && <p className="text-xs text-status-warning">{t('aito.contactsUnavailable')}</p>}

      {listed ? (
        <div>
          <button
            type="button"
            onClick={() => setOverrideOpen((o) => !o)}
            aria-expanded={overrideOpen}
            className={`flex items-center gap-1 text-xs font-semibold text-sky-400 hover:underline ${focusRingCls}`}
          >
            <ChevronRight className={`h-3.5 w-3.5 transition-transform ${overrideOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
            {t('aito.contactOverrideToggle')}
          </button>
          {overrideOpen && (
            <div className="mt-2 space-y-3 rounded-lg border border-bambu-dark-tertiary p-3">
              <p className="text-xs text-bambu-gray">{t('aito.contactOverrideHint')}</p>
              {contactInputs}
            </div>
          )}
        </div>
      ) : (
        contactInputs
      )}

      {/* No revert button beside this one, unlike phone and email: those two
          are written back to Zoho and their reset returns them to the STORED
          value. This field has no stored value to return to — picking the
          selected network again clears it, which is the whole undo it needs. */}
      {!companyBranch && (
        <SocialInput
          idPrefix="aito-client"
          network={value.socialNetwork}
          handle={value.socialHandle}
          onChange={(next) => onChange({ ...value, socialNetwork: next.network, socialHandle: next.handle })}
        />
      )}

      <div className="border-t border-bambu-dark-tertiary pt-3 mt-3">
        {shipping === null ? (
          <button
            type="button"
            onClick={() => onShippingChange(emptyShippingDraft(value))}
            className={`flex w-full items-center justify-center gap-2 rounded-[.6rem] border border-dashed border-sky-400/45 bg-sky-400/[0.05] px-3 py-2.5 text-sm font-semibold text-sky-400 transition-colors hover:bg-sky-400/10 ${focusRingCls}`}
          >
            <Plane className="h-4 w-4" />
            {t('aito.shippingAdd')}
          </button>
        ) : (
          <div className="animate-rise rounded-[.6rem] border border-sky-400/35 bg-sky-400/[0.04] p-3">
            <div className="mb-2.5 flex items-center gap-2">
              <Plane className="h-4 w-4 text-sky-400" aria-hidden="true" />
              <span className="text-xs font-semibold uppercase tracking-wider text-sky-400">
                {t('aito.shippingTitle')}
              </span>
              <button
                type="button"
                onClick={() => onShippingChange(null)}
                className={`ml-auto rounded-md px-1.5 py-0.5 text-xs text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
              >
                {t('aito.shippingRemove')}
              </button>
            </div>
            <ShippingFields
              value={shipping}
              onChange={onShippingChange}
              services={servicesQuery.data?.services ?? []}
              catalogueResolved={servicesQuery.data?.catalogue_resolved ?? false}
              currency={currency}
            />
          </div>
        )}
      </div>
    </div>
  );
}
