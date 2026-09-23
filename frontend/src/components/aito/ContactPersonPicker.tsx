import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { ZohoContactPerson } from '../../api/client';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { eyebrowCls } from './panelTypography';
import { focusRingCls, inputCls, inputErrorCls, labelCls } from '../formStyles';
import {
  DEFAULT_COUNTRY_CODE,
  contactPersonPhone,
  formatPhone,
  formatPhoneDisplay,
  maskVisibleErrors,
  pickDefaultPerson,
  titleCaseSegments,
  upperCaseName,
  validateEmail,
  validatePhone,
} from '../../utils/clientDraft';

export interface ContactPersonPickerProps {
  contactId: string;
  /** Selected person id; null = nothing chosen yet. */
  value: string | null;
  /** Preferred pick when `value` is null: undefined = still unknown (wait),
   *  null = no preference. Falls back to the primary, then the first row. */
  preferredId: string | null | undefined;
  onSelect: (person: ZohoContactPerson) => void;
  /** Fired once per load with whether the account has any persons. */
  onLoaded?: (hasPersons: boolean) => void;
  /** Fired when the list cannot be read; the parent falls back to plain inputs. */
  onUnavailable?: () => void;
  variant: 'drawer' | 'sheet';
  /** Default true. The contact sheet passes false: a card that was saved
   *  with no person (a legacy card, or one the operator deliberately left
   *  person-less) must stay person-less on open — auto-picking Books'
   *  primary for it would silently narrow the coordinate fan-out to just
   *  that person's other siblings. The drawer (a brand-new card) keeps the
   *  default, since there is no prior person-less state to preserve. */
  autoSelect?: boolean;
}

export const CONTACT_PERSONS_KEY = 'zoho-contact-persons';

/** The people on a company's Books account, as a radio list, with an inline
 *  form that adds one to Books and selects it. Owns the list query and the
 *  add form only — coordinates are the parent's (see `applyContactPerson`). */
export function ContactPersonPicker({
  contactId,
  value,
  preferredId,
  onSelect,
  onLoaded,
  onUnavailable,
  variant,
  autoSelect = true,
}: ContactPersonPickerProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [CONTACT_PERSONS_KEY, contactId],
    queryFn: () => api.listZohoContactPersons(contactId),
    staleTime: 60_000,
    retry: false,
  });
  const persons = query.data ?? [];

  // Report load/failure once per contact id, not once per render.
  const reportedFor = useRef<string | null>(null);
  useEffect(() => {
    if (reportedFor.current === contactId) return;
    if (query.isSuccess) {
      reportedFor.current = contactId;
      onLoaded?.(query.data.length > 0);
    } else if (query.isError) {
      reportedFor.current = contactId;
      onUnavailable?.();
    }
  }, [contactId, query.isSuccess, query.isError, query.data, onLoaded, onUnavailable]);

  // Auto-select once, when the list is in and the preference is known.
  const autoSelectedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSelect || value !== null || preferredId === undefined || !query.isSuccess) return;
    if (autoSelectedFor.current === contactId) return;
    const pick = pickDefaultPerson(query.data, preferredId);
    if (!pick) return;
    autoSelectedFor.current = contactId;
    onSelect(pick);
  }, [autoSelect, value, preferredId, query.isSuccess, query.data, contactId, onSelect]);

  const [adding, setAdding] = useState(false);

  const compact = variant === 'sheet';
  const rowPad = compact ? 'py-1.5' : 'py-2';
  const rowCls = `flex items-center gap-2.5 px-3 ${rowPad} cursor-pointer border-t border-bambu-dark-tertiary first:border-t-0 has-[:checked]:bg-bambu-green/10 hover:bg-bambu-dark-tertiary/60`;

  if (query.isError) return null;

  // Books answers seconds after the client is picked, and the list is the
  // tallest thing in the section. So the wait is drawn in the list's own
  // shape — label, bordered box, two ghost rows, the status line where the
  // add button will be — and the rows fade in over it when they arrive,
  // each a beat after the last (the motion system's 50ms child stagger,
  // trimmed to 40 for rows this short). What moves underneath is then only
  // the difference between two ghost rows and the real count, not a whole
  // box landing on a one-line notice. A cached list (same client re-picked
  // within a minute) never passes through this branch at all.
  const pending = query.isPending;

  return (
    <div data-testid={pending ? 'contact-persons-skeleton' : undefined} aria-busy={pending || undefined}>
      <span className={compact ? `${eyebrowCls} mb-1 block font-medium text-bambu-gray` : labelCls}>
        {t('aito.contactsLabel')}
        {!compact && <span className="ml-1.5 font-normal normal-case text-bambu-gray">— {t('aito.contactsHint')}</span>}
      </span>
      <div className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark overflow-hidden">
        {pending ? (
          <>
            {[0, 1].map((i) => (
              <div
                key={i}
                aria-hidden="true"
                className={`flex items-center gap-2.5 px-3 ${rowPad} border-t border-bambu-dark-tertiary first:border-t-0 motion-safe:animate-pulse`}
              >
                <span className="h-[13px] w-[13px] flex-shrink-0 rounded-full border border-bambu-dark-tertiary" />
                <span className="h-3 rounded bg-bambu-dark-tertiary" style={{ width: i === 0 ? '38%' : '30%' }} />
                <span className="ml-auto h-2.5 w-[22%] rounded bg-bambu-dark-tertiary/60" />
              </div>
            ))}
            <p role="status" className="border-t border-bambu-dark-tertiary py-2 text-center text-xs text-bambu-gray">
              {t('aito.contactsLoading')}
            </p>
          </>
        ) : (
          <>
        {/* Only the radio rows belong to the group — the add button and its
            form are actions beside the list, not selectable options within
            it, so they sit as siblings of the radiogroup rather than inside
            it. The outer div keeps the shared border/rounding. */}
        <div role="radiogroup" aria-label={t('aito.contactsLabel')}>
          {persons.map((person, index) => {
            const number = contactPersonPhone(person);
            return (
              <label
                key={person.contact_person_id}
                className={`${rowCls} animate-rise`}
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <input
                  type="radio"
                  name={`contact-person-${contactId}`}
                  value={person.contact_person_id}
                  checked={value === person.contact_person_id}
                  onChange={() => onSelect(person)}
                  aria-label={person.name}
                  className="accent-bambu-green"
                />
                {/* Sheet variant: the name is the primary information, so it
                    keeps its own room (shrink-0, capped at 45%) and the
                    coordinates truncate instead — the drawer variant keeps its
                    original balance (name flexes, coordinates shrink). */}
                <span
                  className={
                    compact
                      ? 'max-w-[45%] shrink-0 truncate text-sm font-semibold text-white'
                      : 'min-w-0 flex-1 truncate text-sm font-semibold text-white'
                  }
                >
                  {person.name}
                </span>
                <span
                  className={
                    compact
                      ? 'flex min-w-0 flex-1 items-center justify-end gap-2 text-xs text-bambu-gray'
                      : 'flex min-w-0 shrink items-center gap-2 text-xs text-bambu-gray'
                  }
                >
                  {number && <span className="truncate">{formatPhoneDisplay(number)}</span>}
                  {person.email && <span className="truncate">{person.email}</span>}
                </span>
                {person.is_primary && (
                  <span className="rounded-full bg-bambu-dark-tertiary px-1.5 py-px text-[.65rem] uppercase tracking-wider text-bambu-gray">
                    {t('aito.contactPrimary')}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        {adding ? (
          <AddContactForm
            contactId={contactId}
            compact={compact}
            onCancel={() => setAdding(false)}
            onCreated={(person) => {
              queryClient.setQueryData<ZohoContactPerson[]>([CONTACT_PERSONS_KEY, contactId], (old) => [
                ...(old ?? []),
                person,
              ]);
              setAdding(false);
              onSelect(person);
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            // Last in the cascade: one stagger slot after the final row.
            style={{ animationDelay: `${persons.length * 40}ms` }}
            className={`animate-rise flex w-full items-center justify-center gap-1.5 border-t border-bambu-dark-tertiary py-2 text-sm font-semibold text-bambu-green-light hover:bg-bambu-dark-tertiary/60 ${persons.length === 0 ? 'border-t-0' : ''} ${focusRingCls}`}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('aito.contactAdd')}
          </button>
        )}
          </>
        )}
      </div>
    </div>
  );
}

interface AddContactFormProps {
  contactId: string;
  compact: boolean;
  onCancel: () => void;
  onCreated: (person: ZohoContactPerson) => void;
}

/** Inline, under the list (brainstorm option A): first name required, phone
 *  OR email required. Casing on blur mirrors the contact sheet; the server
 *  re-applies it anyway. Unmounted on cancel, so nothing typed survives. */
function AddContactForm({ contactId, compact, onCancel, onCreated }: AddContactFormProps) {
  const { t } = useTranslation();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE);
  const [nationalNumber, setNationalNumber] = useState('');
  const [email, setEmail] = useState('');
  const [blurred, setBlurred] = useState({ phone: false, email: false });
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => firstRef.current?.focus(), []);

  const phone = { countryCode, nationalNumber };
  const phoneError = validatePhone(phone);
  const emailError = validateEmail(email);
  const visible = maskVisibleErrors({ phone: phoneError, email: emailError }, blurred);
  const hasFirst = firstName.trim() !== '';
  const reachable = nationalNumber.replace(/\D/g, '') !== '' || email.trim() !== '';

  const mutation = useMutation({
    mutationFn: () =>
      api.createZohoContactPerson(contactId, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        email: email.trim(),
        phone: formatPhone(phone),
      }),
    onSuccess: onCreated,
    onError: (e: unknown) => setError(e instanceof ApiError && e.message ? e.message : t('aito.contactAddFailed')),
  });
  const canSubmit = hasFirst && reachable && !visible.phone && !visible.email && !mutation.isPending;

  const submit = () => {
    setBlurred({ phone: true, email: true });
    if (!hasFirst || !reachable || phoneError || emailError) return;
    setError(null);
    mutation.mutate();
  };

  const fieldLabel = compact ? `${eyebrowCls} mb-1 block font-medium text-bambu-gray` : `${labelCls}`;
  const ids = `add-contact-${contactId}`;

  return (
    <div
      className="space-y-2.5 border-t border-bambu-dark-tertiary bg-bambu-dark-secondary/60 px-3 pb-3 pt-2.5"
      data-testid="add-contact-form"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          submit();
        }
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="text-xs font-semibold text-white">{t('aito.contactAddTitle')}</p>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label htmlFor={`${ids}-first`} className={fieldLabel}>
            {t('aito.firstName')} *
          </label>
          <input
            ref={firstRef}
            id={`${ids}-first`}
            type="text"
            autoComplete="new-password"
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
              setError(null);
            }}
            onBlur={(e) => setFirstName(titleCaseSegments(e.target.value))}
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor={`${ids}-last`} className={fieldLabel}>
            {t('aito.lastName')}
          </label>
          <input
            id={`${ids}-last`}
            type="text"
            autoComplete="new-password"
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
              setError(null);
            }}
            onBlur={(e) => setLastName(upperCaseName(e.target.value))}
            className={inputCls}
          />
        </div>
      </div>
      <div className={compact ? 'space-y-2.5' : 'grid grid-cols-2 gap-2.5'}>
        <div>
          <label htmlFor={`${ids}-phone`} className={fieldLabel}>
            {t('aito.clientPhone')}
          </label>
          <PhoneInput
            id={`${ids}-phone`}
            countryCode={countryCode}
            nationalNumber={nationalNumber}
            invalid={visible.phone !== null}
            onBlur={() => setBlurred((b) => ({ ...b, phone: true }))}
            onChange={(next, changed) => {
              setCountryCode(next.countryCode);
              setNationalNumber(next.nationalNumber);
              setError(null);
              if (changed === 'countryCode') setBlurred((b) => ({ ...b, phone: true }));
            }}
          />
          <FieldError messageKey={visible.phone} />
        </div>
        <div>
          <label htmlFor={`${ids}-email`} className={fieldLabel}>
            {t('aito.clientEmail')}
          </label>
          <input
            id={`${ids}-email`}
            type="email"
            autoComplete="new-password"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            onBlur={() => setBlurred((b) => ({ ...b, email: true }))}
            placeholder={t('aito.emailPlaceholder')}
            aria-invalid={visible.email !== null ? true : undefined}
            className={visible.email !== null ? inputErrorCls : inputCls}
          />
          <FieldError messageKey={visible.email} />
        </div>
      </div>
      {/* Brief note: no `hasFirst &&` guard — the "needs phone or email" hint
       *  shows whenever unreachable, even before a first name is typed, so
       *  both requirements are visible together from the start. */}
      {!hasFirst && <p className="text-xs text-bambu-gray">{t('aito.contactFirstNameRequired')}</p>}
      {!reachable && <p className="text-xs text-bambu-gray">{t('aito.contactNeedsPhoneOrEmail')}</p>}
      {error && <p className="text-sm text-status-error">{error}</p>}
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className={`rounded-lg px-3 py-1.5 text-sm text-bambu-gray-light transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className={`rounded-lg bg-bambu-green px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-bambu-green-light disabled:opacity-50 ${focusRingCls}`}
        >
          {t('aito.contactSaveToZoho')}
        </button>
      </div>
    </div>
  );
}
