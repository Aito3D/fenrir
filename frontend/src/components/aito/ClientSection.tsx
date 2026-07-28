import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { ClientCombobox } from './ClientCombobox';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { visibleClientDraftErrors, defaultClientDraft, draftFromContact, parsePhone } from '../../utils/clientDraft';
import type { ClientDraft } from '../../utils/clientDraft';
import { focusRingCls, inputCls, inputErrorCls, labelCls } from '../formStyles';

export interface ClientSectionProps {
  value: ClientDraft;
  onChange: (next: ClientDraft) => void;
  onCreateNew: () => void;
  defaultContactId: string;
  defaultContactName: string;
}

/** The client half of the Aito new-project form: who the client is, plus the
 *  phone and email that will be written back to Zoho.
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
}: ClientSectionProps) {
  const { t } = useTranslation();
  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });

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

  return (
    <div className="space-y-3">
      <ClientCombobox
        clientName={value.name}
        onSelect={selectContact}
        onCreateNew={onCreateNew}
        onReset={() => onChange(defaultClientDraft(defaultContactId, defaultContactName))}
        showReset={value.id !== defaultContactId}
      />

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
    </div>
  );
}
