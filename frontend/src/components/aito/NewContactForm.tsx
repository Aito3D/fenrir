import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { Button } from '../Button';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { inputCls, inputErrorCls, labelCls } from '../formStyles';
import {
  DEFAULT_COUNTRY_CODE,
  formatDisplayName,
  formatPhone,
  maskVisibleErrors,
  titleCaseSegments,
  validateEmail,
  validatePhone,
} from '../../utils/clientDraft';

export interface NewContactFormProps {
  onCancel: () => void;
  onCreated: (contact: ZohoContact) => void;
}

/** Create-contact sub-step of the Aito new-project modal.
 *
 *  Company and person are mutually exclusive: filling one disables the other,
 *  which is what makes the display name unambiguous. Casing is normalized on
 *  blur rather than per keystroke — per-keystroke fights hyphenated names like
 *  "Jean-Pierre" while they are still being typed — and re-applied server-side.
 *  This writes to Zoho immediately on submit because the real contact_id is
 *  needed before the contact can be attached to a project. */
export function NewContactForm({ onCancel, onCreated }: NewContactFormProps) {
  const { t } = useTranslation();
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE);
  const [nationalNumber, setNationalNumber] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blurred, setBlurred] = useState({ phone: false, email: false });

  const hasCompany = companyName.trim().length > 0;
  const hasPerson = firstName.trim().length > 0 || lastName.trim().length > 0;
  const hasName = hasCompany || (firstName.trim().length > 0 && lastName.trim().length > 0);
  const preview = hasCompany ? companyName.trim() : formatDisplayName(firstName, lastName);

  const phoneError = validatePhone({ countryCode, nationalNumber });
  const emailError = validateEmail(email);
  // Neither field is required on its own, but the drawer (and the backend's
  // project-create route) refuse a client with no way to reach them — so the
  // same phone-OR-email rule applies here, surfaced as an always-visible hint
  // rather than a per-field error.
  const reachable = nationalNumber.replace(/\D/g, '') !== '' || email.trim() !== '';
  const visibleErrors = maskVisibleErrors({ phone: phoneError, email: emailError }, blurred);
  // The button gates on what the user can SEE, the submit handler on what is
  // actually true — so a disabled button always has a message beside it
  // (`reachable` may gate too because its hint is never masked).
  const canSubmit = hasName && reachable && !visibleErrors.phone && !visibleErrors.email;

  const createMutation = useMutation({
    mutationFn: () =>
      api.createZohoContact({
        company_name: hasCompany ? companyName.trim() : '',
        first_name: hasCompany ? '' : titleCaseSegments(firstName),
        last_name: hasCompany ? '' : lastName.trim().toLocaleUpperCase('fr'),
        email: email.trim(),
        phone: formatPhone({ countryCode, nationalNumber }),
      }),
    onSuccess: (data) => onCreated(data),
    onError: (e: Error) => setError(e.message || t('aito.clientCreateFailed')),
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // Reveal anything the user never triggered by blurring. `canSubmit` was
        // computed before this call, so the guard below re-checks the raw
        // errors rather than re-reading it.
        setBlurred({ phone: true, email: true });
        if (!hasName || !reachable || phoneError || emailError) return;
        setError(null);
        createMutation.mutate();
      }}
      // animate-rise: this form swaps in where ClientSection stood (see the
      // drawer's `creatingClient` ternary), and the rise is the bridge — its
      // counterpart is on the wrapper ClientSection remounts into.
      className="animate-rise flex flex-col flex-1 min-h-0"
    >
      <div className="p-4 overflow-y-auto flex-1 space-y-4 scrollbar-hide">
        <div>
          <label htmlFor="aito-company" className={labelCls}>
            {t('aito.companyName')}
          </label>
          <input
            id="aito-company"
            type="text"
            autoComplete="new-password"
            value={companyName}
            disabled={hasPerson}
            onChange={(e) => setCompanyName(e.target.value)}
            className={`${inputCls} disabled:opacity-40`}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="aito-first-name" className={labelCls}>
              {t('aito.firstName')}
            </label>
            <input
              id="aito-first-name"
              type="text"
              autoComplete="new-password"
              value={firstName}
              disabled={hasCompany}
              onChange={(e) => setFirstName(e.target.value)}
              onBlur={(e) => setFirstName(titleCaseSegments(e.target.value))}
              className={`${inputCls} disabled:opacity-40`}
            />
          </div>
          <div>
            <label htmlFor="aito-last-name" className={labelCls}>
              {t('aito.lastName')}
            </label>
            <input
              id="aito-last-name"
              type="text"
              autoComplete="new-password"
              value={lastName}
              disabled={hasCompany}
              onChange={(e) => setLastName(e.target.value)}
              onBlur={(e) => setLastName(e.target.value.trim().toLocaleUpperCase('fr'))}
              className={`${inputCls} disabled:opacity-40`}
            />
          </div>
        </div>

        <p className="text-xs text-bambu-gray">
          {hasName ? t('aito.displayNamePreview', { name: preview }) : t('aito.clientNameRequired')}
        </p>

        <div>
          <label htmlFor="aito-new-phone" className={labelCls}>
            {t('aito.clientPhone')}
          </label>
          <PhoneInput
            id="aito-new-phone"
            countryCode={countryCode}
            nationalNumber={nationalNumber}
            invalid={visibleErrors.phone !== null}
            onBlur={() => setBlurred((b) => ({ ...b, phone: true }))}
            onChange={(next, changed) => {
              setCountryCode(next.countryCode);
              setNationalNumber(next.nationalNumber);
              if (changed === 'countryCode') setBlurred((b) => ({ ...b, phone: true }));
            }}
          />
          <FieldError messageKey={visibleErrors.phone} />
        </div>

        <div>
          <label htmlFor="aito-new-email" className={labelCls}>
            {t('aito.clientEmail')}
          </label>
          <input
            id="aito-new-email"
            type="email"
            autoComplete="new-password"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setBlurred((b) => ({ ...b, email: true }))}
            placeholder={t('aito.emailPlaceholder')}
            aria-invalid={visibleErrors.email !== null ? true : undefined}
            className={visibleErrors.email !== null ? inputErrorCls : inputCls}
          />
          <FieldError messageKey={visibleErrors.email} />
        </div>

        {!reachable && <p className="text-xs text-bambu-gray">{t('aito.ruleClientContact')}</p>}

        {error && <p className="text-sm text-status-error">{error}</p>}
      </div>

      <div className="p-4 border-t border-bambu-dark-tertiary flex justify-between gap-2 flex-shrink-0">
        <Button type="button" variant="secondary" onClick={onCancel}>
          <ArrowLeft className="w-4 h-4 mr-2" />
          {t('aito.back')}
        </Button>
        <Button type="submit" disabled={!canSubmit || createMutation.isPending}>
          <Plus className="w-4 h-4 mr-2" />
          {t('aito.createClientSubmit')}
        </Button>
      </div>
    </form>
  );
}
