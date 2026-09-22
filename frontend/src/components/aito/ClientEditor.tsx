import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { AitoClientEdit, AitoProject, ZohoContactDetail } from '../../api/client';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { focusRingCls, inputCls, inputErrorCls, labelCls } from '../formStyles';
import {
  DEFAULT_COUNTRY_CODE,
  formatPhone,
  maskVisibleErrors,
  parsePhone,
  splitDisplayName,
  titleCaseSegments,
  validateEmail,
  validatePhone,
} from '../../utils/clientDraft';

export interface ClientEditorProps {
  project: AitoProject;
  /** The edited card as the server returned it. The caller owns the cache
   *  write — and the board refetch the fan-out to sibling cards needs. */
  onSaved: (updated: AitoProject) => void;
  onCancel: () => void;
}

interface Draft {
  companyName: string;
  firstName: string;
  lastName: string;
  countryCode: string;
  nationalNumber: string;
  email: string;
  phoneField: 'phone' | 'mobile';
}

function draftFromProject(project: AitoProject): Draft {
  const parsed = parsePhone(project.client_phone ?? '');
  const { firstName, lastName } = splitDisplayName(project.client_name ?? '');
  return {
    companyName: project.client_name ?? '',
    firstName,
    lastName,
    countryCode: parsed.countryCode || DEFAULT_COUNTRY_CODE,
    nationalNumber: parsed.nationalNumber,
    email: project.client_email ?? '',
    phoneField: 'mobile',
  };
}

function draftFromContact(contact: ZohoContactDetail): Draft {
  // Same field preference `draftFromContact` in clientDraft.ts uses for the
  // drawer: the number is written back to whichever field it came from.
  const phoneField: 'phone' | 'mobile' = contact.mobile ? 'mobile' : contact.phone ? 'phone' : 'mobile';
  const parsed = parsePhone(contact.mobile || contact.phone || '');
  return {
    companyName: contact.company_name || contact.name,
    firstName: contact.first_name,
    lastName: contact.last_name,
    countryCode: parsed.countryCode || DEFAULT_COUNTRY_CODE,
    nationalNumber: parsed.nationalNumber,
    email: contact.email,
    phoneField,
  };
}

/** Inline editor for the contact behind a card: name, phone and email.
 *
 *  Prefills from the LIVE Zoho contact, not the card's snapshot — the
 *  operator is editing Books' record, so the fields must show what Books
 *  holds (a sibling card may have corrected the number since this snapshot
 *  was taken). The snapshot is the fallback when Books cannot be read, and
 *  the only source for a walk-in card, whose shared contact Books refuses
 *  to edit at all (routes/zoho.py:patch_contact) — that card takes a
 *  card-only edit and says so.
 *
 *  The card's company/person type is fixed: a company card edits its company
 *  name, a person card its first/last name. Flipping the type would change
 *  the Books customer sub-type, which is not an edit this editor offers.
 *
 *  Save is Zoho-first on the server (routes/aito.py:edit_project_client), so
 *  a Books refusal comes back as an error with the draft still on screen —
 *  the editor closes only through `onSaved`. */
export function ClientEditor({ project, onSaved, onCancel }: ClientEditorProps) {
  const { t } = useTranslation();
  const isCompany = project.client_is_company === true;

  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });
  const defaultContactId = statusQuery.data?.default_contact_id;
  // Unknown until the status resolves: nothing is read from Zoho until we
  // know whether this card's contact is the one Books will refuse.
  const isWalkIn = defaultContactId !== undefined && (project.client_id === null || project.client_id === defaultContactId);
  const contactQuery = useQuery({
    queryKey: ['zoho-contact', project.client_id],
    queryFn: () => api.getZohoContact(project.client_id as string),
    enabled: defaultContactId !== undefined && !isWalkIn,
    staleTime: 0,
    retry: false,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [blurred, setBlurred] = useState({ phone: false, email: false });
  const [error, setError] = useState<string | null>(null);
  // The version this edit is BASED ON, captured once on open — same
  // discipline as the panel's social editor (see socialEditVersionRef).
  const versionRef = useRef(project.version);

  // Prefill exactly once, from whichever source resolves first: the Zoho
  // contact when it can be read, the card snapshot otherwise. Never re-run
  // on a later refetch — that would clobber what the operator has typed.
  // A status read that fails is Zoho down as surely as a contact read that
  // fails, so it takes the same fallback rather than leaving the editor on
  // its loading line forever.
  const zohoReadFailed = statusQuery.isError || contactQuery.isError;
  useEffect(() => {
    if (draft !== null) return;
    if (isWalkIn || zohoReadFailed) {
      setDraft(draftFromProject(project));
    } else if (contactQuery.data) {
      setDraft(draftFromContact(contactQuery.data));
    }
  }, [draft, isWalkIn, zohoReadFailed, contactQuery.data, project]);

  const mutation = useMutation({
    mutationFn: (body: AitoClientEdit) => api.editAitoClient(project.id, body),
    onSuccess: (updated) => onSaved(updated),
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.code === 'version_conflict') setError(t('aito.editConflict'));
      else setError(e instanceof Error && e.message ? e.message : t('aito.clientEditFailed'));
    },
  });

  if (draft === null) {
    return (
      <div className="animate-rise mt-3 max-w-md rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3">
        <p className="text-sm text-bambu-gray" role="status">
          {t('aito.clientEditLoading')}
        </p>
      </div>
    );
  }

  const hasName = isCompany
    ? draft.companyName.trim().length > 0
    : draft.firstName.trim().length > 0 && draft.lastName.trim().length > 0;
  const phone = { countryCode: draft.countryCode, nationalNumber: draft.nationalNumber };
  const phoneError = validatePhone(phone);
  const emailError = validateEmail(draft.email);
  const visibleErrors = maskVisibleErrors({ phone: phoneError, email: emailError }, blurred);
  // Same rule the create form and the server apply: one channel is enough,
  // and the card's own social handle counts even though Zoho never sees it.
  const reachable =
    draft.nationalNumber.replace(/\D/g, '') !== '' ||
    draft.email.trim() !== '' ||
    (project.client_social_handle ?? '').trim() !== '';
  const canSubmit = hasName && reachable && !visibleErrors.phone && !visibleErrors.email && !mutation.isPending;

  const submit = () => {
    setBlurred({ phone: true, email: true });
    if (!hasName || !reachable || phoneError || emailError) return;
    setError(null);
    const body: AitoClientEdit = {
      ...(isCompany
        ? { company_name: draft.companyName.trim() }
        : { first_name: draft.firstName.trim(), last_name: draft.lastName.trim() }),
      email: draft.email.trim(),
      phone: formatPhone(phone),
      phone_field: draft.phoneField,
      expected_version: versionRef.current,
    };
    mutation.mutate(body);
  };

  const update = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const fieldCls = `${inputCls} disabled:opacity-40`;

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      // animate-rise: same arrival the social editor and ShippingCard's edit
      // form use — the editor appears in response to the pencil beside the
      // name it replaces.
      className="animate-rise mt-3 max-w-md rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 space-y-3"
      aria-label={t('aito.clientEdit')}
    >
      {isWalkIn && <p className="text-xs text-bambu-gray">{t('aito.clientEditWalkIn')}</p>}
      {!isWalkIn && zohoReadFailed && (
        <p className="text-xs text-status-warning">{t('aito.clientEditZohoReadFailed')}</p>
      )}

      {isCompany ? (
        <div>
          <label htmlFor="panel-client-company" className={labelCls}>
            {t('aito.companyName')}
          </label>
          <input
            id="panel-client-company"
            type="text"
            autoComplete="new-password"
            value={draft.companyName}
            onChange={(e) => update({ companyName: e.target.value })}
            className={fieldCls}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="panel-client-first-name" className={labelCls}>
              {t('aito.firstName')}
            </label>
            <input
              id="panel-client-first-name"
              type="text"
              autoComplete="new-password"
              value={draft.firstName}
              onChange={(e) => update({ firstName: e.target.value })}
              onBlur={(e) => update({ firstName: titleCaseSegments(e.target.value) })}
              className={fieldCls}
            />
          </div>
          <div>
            <label htmlFor="panel-client-last-name" className={labelCls}>
              {t('aito.lastName')}
            </label>
            <input
              id="panel-client-last-name"
              type="text"
              autoComplete="new-password"
              value={draft.lastName}
              onChange={(e) => update({ lastName: e.target.value })}
              onBlur={(e) => update({ lastName: e.target.value.trim().toLocaleUpperCase('fr') })}
              className={fieldCls}
            />
          </div>
        </div>
      )}
      {!hasName && <p className="text-xs text-bambu-gray">{t('aito.clientNameRequired')}</p>}

      <div>
        <label htmlFor="panel-client-phone" className={labelCls}>
          {t('aito.clientPhone')}
        </label>
        <PhoneInput
          id="panel-client-phone"
          countryCode={draft.countryCode}
          nationalNumber={draft.nationalNumber}
          invalid={visibleErrors.phone !== null}
          onBlur={() => setBlurred((b) => ({ ...b, phone: true }))}
          onChange={(next, changed) => {
            update({ countryCode: next.countryCode, nationalNumber: next.nationalNumber });
            if (changed === 'countryCode') setBlurred((b) => ({ ...b, phone: true }));
          }}
        />
        <FieldError messageKey={visibleErrors.phone} />
      </div>

      <div>
        <label htmlFor="panel-client-email" className={labelCls}>
          {t('aito.clientEmail')}
        </label>
        <input
          id="panel-client-email"
          type="email"
          autoComplete="new-password"
          value={draft.email}
          onChange={(e) => update({ email: e.target.value })}
          onBlur={() => setBlurred((b) => ({ ...b, email: true }))}
          placeholder={t('aito.emailPlaceholder')}
          aria-invalid={visibleErrors.email !== null ? true : undefined}
          className={visibleErrors.email !== null ? inputErrorCls : inputCls}
        />
        <FieldError messageKey={visibleErrors.email} />
      </div>

      {!reachable && <p className="text-xs text-bambu-gray">{t('aito.ruleClientContact')}</p>}
      {error && <p className="text-sm text-status-error">{error}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={`rounded-md px-2.5 py-1 text-sm text-bambu-gray transition-colors hover:text-white ${focusRingCls}`}
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className={`rounded-md border border-bambu-green/40 px-2.5 py-1 text-sm text-bambu-green transition-colors hover:bg-bambu-green/10 disabled:opacity-50 ${focusRingCls}`}
        >
          {t('common.save')}
        </button>
      </div>
    </form>
  );
}
