import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { Button } from '../Button';
import { PhoneInput } from './PhoneInput';
import { SocialInput } from './SocialInput';
import { FieldError } from './FieldError';
import { inputCls, inputErrorCls, labelCls } from '../formStyles';
import {
  DEFAULT_COUNTRY_CODE,
  formatPhone,
  maskVisibleErrors,
  titleCaseSegments,
  upperCaseName,
  validateEmail,
  validatePhone,
} from '../../utils/clientDraft';
import type { SocialNetwork } from '../../utils/clientDraft';

export interface NewContactFormProps {
  onCancel: () => void;
  /** The social channel rides back separately because it is NOT part of the
   *  Zoho contact this form just created — Zoho has no field for it. Without
   *  this second argument the handle would vanish the instant the contact was
   *  created, on precisely the path where it is most often the ONLY way to
   *  reach the client. A company hands back the empty pair: its people are
   *  its contact list, and the chooser is folded away for it. */
  onCreated: (contact: ZohoContact, social: { network: SocialNetwork | null; handle: string }) => void;
}

/** Create-contact sub-step of the Aito new-project modal.
 *
 *  One form, no type switch: the company field decides. Empty, the name
 *  fields are the client (an individual — both names required). Filled, they
 *  are the CONTACT PERSON at that company, whoever walked in for it — a first
 *  name is enough, same as the picker's add form — and they land on the
 *  account's primary contact row in Books in the same create call, so the
 *  new card can pre-select them. The preview line always states which of the
 *  two is about to happen; it is what stands in for an explicit choice.
 *
 *  Casing is normalized on blur rather than per keystroke — per-keystroke
 *  fights hyphenated names like "Jean-Pierre" while they are still being
 *  typed — and re-applied server-side. This writes to Zoho immediately on
 *  submit because the real contact_id is needed before the contact can be
 *  attached to a project. */
export function NewContactForm({ onCancel, onCreated }: NewContactFormProps) {
  const { t } = useTranslation();
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE);
  const [nationalNumber, setNationalNumber] = useState('');
  const [email, setEmail] = useState('');
  const [socialNetwork, setSocialNetwork] = useState<SocialNetwork | null>(null);
  const [socialHandle, setSocialHandle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [blurred, setBlurred] = useState({ phone: false, email: false });

  const company = companyName.trim();
  const hasCompany = company !== '';
  const personFirst = titleCaseSegments(firstName);
  const personLast = upperCaseName(lastName);
  const person = [personFirst, personLast].filter(Boolean).join(' ');
  const hasName = hasCompany || (personFirst !== '' && personLast !== '');

  const phoneError = validatePhone({ countryCode, nationalNumber });
  const emailError = validateEmail(email);
  // Any ONE of the channels is enough. For an individual the social handle
  // counts even though it never reaches Zoho: the project row is what has to
  // be reachable, and the create route agrees (routes/aito.py,
  // create_project). A company has no social channel (its people are the
  // contact list, and the client section never shows one on a company card),
  // so only the phone and the email count for it — a handle typed before the
  // company name was is kept in state, out of sight, and never handed back.
  const hasPhoneOrEmail = nationalNumber.replace(/\D/g, '') !== '' || email.trim() !== '';
  const reachable = hasPhoneOrEmail || (!hasCompany && socialHandle.trim() !== '');
  const visibleErrors = maskVisibleErrors({ phone: phoneError, email: emailError }, blurred);
  // The button gates on what the user can SEE, the submit handler on what is
  // actually true — so a disabled button always has a message beside it
  // (`reachable` may gate too because its hint is never masked).
  const canSubmit = hasName && reachable && !visibleErrors.phone && !visibleErrors.email;

  const createMutation = useMutation({
    mutationFn: () =>
      api.createZohoContact({
        company_name: company,
        first_name: personFirst,
        last_name: personLast,
        email: email.trim(),
        phone: formatPhone({ countryCode, nationalNumber }),
      }),
    onSuccess: (data) =>
      onCreated(
        data,
        hasCompany ? { network: null, handle: '' } : { network: socialNetwork, handle: socialHandle.trim() },
      ),
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
            onChange={(e) => setCompanyName(e.target.value)}
            className={inputCls}
          />
        </div>

        {/* The person block. `data-company` draws the green line down its
            left edge in the form's gutter (index.css, .aito-nest): the
            fields never move, the line is what says "these belong to the
            company above". The eyebrow above the names is keyed on the same
            state, so it swaps meaning with a short blur crossfade instead of
            just changing its words. */}
        <div data-company={hasCompany || undefined} className="aito-nest space-y-4">
          <p className="text-xs min-h-4">
            {hasCompany ? (
              <span key="company" className="animate-aito-swap">
                <span className="font-bold uppercase tracking-wider text-[.7rem] text-bambu-green-light">
                  {t('aito.newClientContactTag')}
                </span>
                <span className="text-bambu-gray"> · {t('aito.newClientContactHint')}</span>
              </span>
            ) : (
              <span key="person" className="animate-aito-swap text-bambu-gray">
                {t('aito.newClientPersonHint')}
              </span>
            )}
          </p>

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
                onChange={(e) => setFirstName(e.target.value)}
                onBlur={(e) => setFirstName(titleCaseSegments(e.target.value))}
                className={inputCls}
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
                onChange={(e) => setLastName(e.target.value)}
                onBlur={(e) => setLastName(upperCaseName(e.target.value))}
                className={inputCls}
              />
            </div>
          </div>

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
        </div>

        {/* What is about to be created, in words. Keyed on the SHAPE (company
            / individual / nothing yet), so the crossfade plays on a change of
            meaning and never on a keystroke. */}
        <p className="text-xs text-bambu-gray">
          {hasCompany ? (
            <span key="company" className="animate-aito-swap">
              {person
                ? t('aito.newClientPreviewCompany', { name: company, person })
                : t('aito.newClientPreviewCompanyAlone', { name: company })}
            </span>
          ) : hasName ? (
            <span key="individual" className="animate-aito-swap">
              {t('aito.newClientPreviewIndividual', { name: person })}
            </span>
          ) : (
            <span key="none">{t('aito.clientNameRequired')}</span>
          )}
        </p>

        {/* Folded away for a company (index.css, .aito-fold): the row
            collapses and fades on the exit curve, and comes back on the
            signature curve when the company name is cleared, handle intact.
            `inert` + aria-hidden take it out of the tab order and the
            accessibility tree while it is folded. The wrapper cancels the
            parent's space-y so a folded chooser leaves no gap; the padding
            inside the clipped area restores it while open. */}
        <div
          data-open={!hasCompany}
          inert={hasCompany || undefined}
          aria-hidden={hasCompany || undefined}
          className="aito-fold mt-0!"
        >
          <div>
            <div className="pt-4">
              <SocialInput
                idPrefix="aito-new"
                network={socialNetwork}
                handle={socialHandle}
                onChange={(next) => {
                  setSocialNetwork(next.network);
                  setSocialHandle(next.handle);
                }}
              />
            </div>
          </div>
        </div>

        {!reachable && (
          <p className="text-xs text-bambu-gray">
            {hasCompany ? t('aito.contactNeedsPhoneOrEmail') : t('aito.ruleClientContact')}
          </p>
        )}

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
