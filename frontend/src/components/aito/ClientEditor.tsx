import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AtSign, Building2, Cloud, User } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { AitoClientEdit, AitoProject, ZohoContactDetail, ZohoContactPerson } from '../../api/client';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { SocialSegment } from './SocialInput';
import { ContactPersonPicker, CONTACT_PERSONS_KEY } from './ContactPersonPicker';
import { eyebrowCls } from './panelTypography';
import { focusRingCls, inputCls, inputErrorCls } from '../formStyles';
import {
  DEFAULT_COUNTRY_CODE,
  contactPersonPhone,
  formatPhone,
  isSocialNetwork,
  maskVisibleErrors,
  parsePhone,
  splitDisplayName,
  titleCaseSegments,
  validateEmail,
  validatePhone,
} from '../../utils/clientDraft';
import type { SocialNetwork } from '../../utils/clientDraft';

export interface ClientEditorProps {
  project: AitoProject;
  /** The edited card as the server returned it. The caller owns the cache
   *  write — and the board refetch the fan-out to sibling cards needs. */
  onSaved: (updated: AitoProject) => void;
  onCancel: () => void;
  /** The control that opened the sheet. A press on it is never "outside" —
   *  it reaches its own toggle instead of closing here and reopening there. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** True while the panel plays the exit: the sheet swaps its entrance for
   *  `animate-aito-sheet-out` and stops taking pointer input, and the panel
   *  unmounts it a beat later (SHEET_OUT_MS). Nothing here fires `onCancel`
   *  again while it is set. */
  closing?: boolean;
}

interface Draft {
  companyName: string;
  firstName: string;
  lastName: string;
  countryCode: string;
  nationalNumber: string;
  email: string;
  phoneField: 'phone' | 'mobile';
  /** Card-only, so always from the card — never from the Books record. */
  socialNetwork: SocialNetwork | null;
  socialHandle: string;
  /** Company cards only: the picked Books contact person. Null on a person
   *  card, and null on a company card until one is picked. */
  contactPersonId: string | null;
  contactName: string;
}

function socialFromProject(project: AitoProject): Pick<Draft, 'socialNetwork' | 'socialHandle'> {
  return {
    socialNetwork: isSocialNetwork(project.client_social_network) ? project.client_social_network : null,
    socialHandle: project.client_social_handle ?? '',
  };
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
    ...socialFromProject(project),
    contactPersonId: project.client_is_company ? (project.client_contact_person_id ?? null) : null,
    contactName: project.client_is_company ? (project.client_contact_name ?? '') : '',
  };
}

/** Shared by `selectPerson` (an explicit pick) and the one-shot prefill
 *  effect (the card's ALREADY-stored person, applied on open): copies a
 *  person's own coordinates into every field the operator has NOT typed in
 *  this session (`editedFlags`) — a correction typed here survives. Module-
 *  level, like `draftFromProject`/`draftFromContact`, so it takes no
 *  dependency on component state and needs no hook dependency entry. */
function applyPersonToDraft(prev: Draft, person: ZohoContactPerson, editedFlags: { phone: boolean; email: boolean }): Draft {
  const raw = contactPersonPhone(person);
  const parsed = parsePhone(raw);
  return {
    ...prev,
    contactPersonId: person.contact_person_id,
    contactName: person.name,
    countryCode: editedFlags.phone ? prev.countryCode : parsed.countryCode || DEFAULT_COUNTRY_CODE,
    nationalNumber: editedFlags.phone ? prev.nationalNumber : parsed.nationalNumber,
    email: editedFlags.email ? prev.email : person.email,
    phoneField: person.mobile ? 'mobile' : person.phone ? 'phone' : 'mobile',
  };
}

function draftFromContact(contact: ZohoContactDetail, project: AitoProject): Draft {
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
    ...socialFromProject(project),
    contactPersonId: project.client_is_company ? (project.client_contact_person_id ?? null) : null,
    contactName: project.client_is_company ? (project.client_contact_name ?? '') : '',
  };
}

/** The sheet's shell: 440px, square-topped, hanging from the masthead.
 *
 *  Positioned by its ANCHOR (a zero-height `relative z-[1]` div the panel
 *  renders right under its header), not by the header itself: the header is
 *  `z-[2]`, so the sheet sits beneath it in the stack and the band's cast
 *  shadow falls onto the sheet's top edge. That is what makes it read as
 *  pulled out from under the band — a child of the header would paint over
 *  it instead. No top border for the same reason: the hidden edge carries no
 *  highlight. `left-5` matches the header's own padding so the sheet's labels
 *  line up with the project eyebrow above. */
const sheetCls =
  'absolute left-5 top-0 w-[440px] max-w-[calc(100%-2.5rem)] rounded-b-[14px] border border-t-0 border-bambu-dark-tertiary bg-bambu-dark-secondary px-4 pb-3.5 pt-4 shadow-[0_30px_60px_-18px_rgba(0,0,0,.9),0_0_0_1px_rgba(0,0,0,.35)]';

/** Entrance or exit, never neither: the sheet always arrives from under the
 *  band and always leaves the same way (spatial consistency — a surface that
 *  exits differently than it entered reads as two surfaces). */
const sheetMotionCls = (closing: boolean) =>
  closing ? 'animate-aito-sheet-out pointer-events-none' : 'animate-aito-sheet-in';

/** Compact field labels: the panel's eyebrow, not the drawer's `labelCls` —
 *  at 440px the sheet has no room for a sentence-case label per field, and
 *  the small caps are what the panel already uses for every card title. */
const fieldLabelCls = `${eyebrowCls} mb-1 block font-medium text-bambu-gray`;

/** The contact sheet behind a card's client name: name, phone, email and the
 *  card's social channel, in ONE editor — the header used to grow a second
 *  form for the social handle alone, and two pencils for one contact read as
 *  two contacts.
 *
 *  Prefills the Books fields from the LIVE Zoho contact, not the card's
 *  snapshot — the operator is editing Books' record, so the fields must show
 *  what Books holds (a sibling card may have corrected the number since this
 *  snapshot was taken). The snapshot is the fallback when Books cannot be
 *  read, and the only source for a walk-in card, whose shared contact Books
 *  refuses to edit at all (routes/zoho.py:patch_contact) — that card takes a
 *  card-only edit and says so. The social pair is card-only either way, so it
 *  always comes from the card.
 *
 *  The card's company/person type is fixed: a company card edits its company
 *  name, a person card its first/last name. Flipping the type would change
 *  the Books customer sub-type, which is not an edit this editor offers.
 *
 *  Save is Zoho-first on the server (routes/aito.py:edit_project_client), so
 *  a Books refusal comes back as an error with the draft still on screen —
 *  the editor closes only through `onSaved`. Escape and an outside press
 *  close it through `onCancel`, the same two exits the date picker has. */
export function ClientEditor({ project, onSaved, onCancel, triggerRef, closing = false }: ClientEditorProps) {
  const { t } = useTranslation();
  const isCompany = project.client_is_company === true;
  const rootRef = useRef<HTMLFormElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

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
  // Same query key `ContactPersonPicker` uses for this contact, so React
  // Query dedupes the two reads into one request — this is only to learn
  // the STORED person's own coordinates (see the one-shot effect below);
  // the picker still owns rendering the list and the add-person flow.
  const personsQuery = useQuery({
    queryKey: [CONTACT_PERSONS_KEY, project.client_id],
    queryFn: () => api.listZohoContactPersons(project.client_id as string),
    enabled: isCompany && !isWalkIn && !!project.client_id,
    staleTime: 60_000,
    retry: false,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [blurred, setBlurred] = useState({ phone: false, email: false });
  // Tracks whether the operator has typed into phone/email THIS session —
  // switching the contact person re-prefills a field only while it is still
  // untouched, so a correction typed here survives a later person switch.
  const [edited, setEdited] = useState({ phone: false, email: false });
  const [error, setError] = useState<string | null>(null);
  // The version this edit is BASED ON, captured once on open — see
  // useProjectPatchMutation's doc for why it is not re-read at save time.
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
      setDraft(draftFromContact(contactQuery.data, project));
    }
  }, [draft, isWalkIn, zohoReadFailed, contactQuery.data, project]);

  // The first field takes focus the moment the prefill lands — the sheet is
  // opened to type, and the pencil that opened it is now behind it.
  const prefilled = draft !== null;
  useEffect(() => {
    if (prefilled) firstFieldRef.current?.focus();
  }, [prefilled]);

  // An outside press abandons the sheet, the same way it abandons the date
  // picker. The trigger is excluded so a press on it reaches its own toggle.
  useEffect(() => {
    if (closing) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onCancel();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [closing, onCancel, triggerRef]);

  const mutation = useMutation({
    mutationFn: (body: AitoClientEdit) => api.editAitoClient(project.id, body),
    onSuccess: (updated) => onSaved(updated),
    onError: (e: unknown) => {
      if (e instanceof ApiError && e.code === 'version_conflict') setError(t('aito.editConflict'));
      else if (e instanceof ApiError && e.code === 'contact_person_gone') setError(t('aito.contactGone'));
      else setError(e instanceof Error && e.message ? e.message : t('aito.clientEditFailed'));
    },
  });

  // Picking a person re-prefills phone/email from THEIR Books record, unless
  // the operator has already typed into that field this session (`edited`) —
  // a correction typed here must survive a later switch, the same rule the
  // Zoho-vs-snapshot prefill above follows for the initial load.
  const selectPerson = (person: ZohoContactPerson) => {
    setDraft((prev) => (prev ? applyPersonToDraft(prev, person, edited) : prev));
  };

  // The initial prefill (draftFromProject/draftFromContact) can only borrow
  // the CONTACT-level mobile/email, which Books mirrors from the contact's
  // PRIMARY person — not necessarily the person this card actually has
  // stored. Once the persons list is in and it contains that stored person,
  // swap the mirror for their own coordinates, once, the same one-shot
  // discipline the Zoho-vs-snapshot prefill above uses: never re-run on a
  // later refetch, and leave the mirror alone if the stored person is gone
  // from the list (a 409 on save is what surfaces that, not this effect).
  const personPrefilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (draft === null || !draft.contactPersonId) return;
    if (!personsQuery.isSuccess) return;
    if (personPrefilledRef.current === project.client_id) return;
    const match = personsQuery.data.find((p) => p.contact_person_id === draft.contactPersonId);
    if (!match) return;
    personPrefilledRef.current = project.client_id;
    setDraft((prev) => (prev ? applyPersonToDraft(prev, match, edited) : prev));
  }, [draft, personsQuery.isSuccess, personsQuery.data, project.client_id, edited]);

  // Escape closes the sheet, not the panel behind it: the panel's own
  // window-level Escape listener (useDismissableDialog) would otherwise fire
  // for the same key. Stopping propagation here is what keeps it from
  // reaching the window — the description textarea uses the same trick.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (!closing) onCancel();
  };

  const TypeIcon = isCompany ? Building2 : User;
  const header = (
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-[.92rem] font-semibold text-white">
        <TypeIcon className="h-[.95rem] w-[.95rem] text-bambu-gray" aria-hidden="true" />
        {t('aito.clientEditTitle')}
      </span>
      {/* Where the save goes. A real Books contact writes to Books; a walk-in
          card writes to this card only, and the badge says so rather than
          promising a Books update the server will never make. */}
      <span
        data-testid="client-edit-source"
        className="inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-1.5 py-0.5 text-[.7rem] font-semibold uppercase tracking-[.06em] text-bambu-gray"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${isWalkIn ? 'bg-bambu-gray' : 'bg-bambu-green-light'}`}
          aria-hidden="true"
        />
        {isWalkIn ? t('aito.clientEditSourceCard') : t('aito.clientEditSourceZoho')}
      </span>
    </div>
  );

  if (draft === null) {
    return (
      <div
        ref={rootRef as unknown as RefObject<HTMLDivElement>}
        data-testid="client-edit-sheet"
        className={`${sheetCls} ${sheetMotionCls(closing)}`}
        onKeyDown={onKeyDown}
      >
        {header}
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
  const socialHandle = draft.socialHandle.trim();
  // Same rule the create form and the server apply: one channel is enough,
  // and the social handle AS EDITED HERE counts — clearing the only channel
  // in this same sheet is refused before the server has to.
  const reachable = draft.nationalNumber.replace(/\D/g, '') !== '' || draft.email.trim() !== '' || socialHandle !== '';
  const canSubmit = hasName && reachable && !visibleErrors.phone && !visibleErrors.email && !mutation.isPending;

  const submit = () => {
    setBlurred({ phone: true, email: true });
    if (!hasName || !reachable || phoneError || emailError) return;
    setError(null);
    const body: AitoClientEdit = {
      ...(isCompany
        ? {
            company_name: draft.companyName.trim(),
            client_contact_person_id: draft.contactPersonId,
            client_contact_name: draft.contactName || null,
          }
        : { first_name: draft.firstName.trim(), last_name: draft.lastName.trim() }),
      email: draft.email.trim(),
      phone: formatPhone(phone),
      phone_field: draft.phoneField,
      // Blank handle clears the pair, matching the server's own rule — a
      // network pointing at nothing is not a state either side keeps.
      client_social_network: socialHandle ? draft.socialNetwork : null,
      client_social_handle: socialHandle || null,
      expected_version: versionRef.current,
    };
    mutation.mutate(body);
  };

  const update = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const fieldCls = `${inputCls} disabled:opacity-40`;

  return (
    <form
      ref={rootRef}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={onKeyDown}
      data-testid="client-edit-sheet"
      className={`${sheetCls} ${sheetMotionCls(closing)} space-y-3`}
      aria-label={t('aito.clientEdit')}
    >
      {header}
      {isWalkIn && <p className="text-xs text-bambu-gray">{t('aito.clientEditWalkIn')}</p>}
      {!isWalkIn && zohoReadFailed && (
        <p className="text-xs text-status-warning">{t('aito.clientEditZohoReadFailed')}</p>
      )}

      {isCompany ? (
        <>
          <div>
            <label htmlFor="panel-client-company" className={fieldLabelCls}>
              {t('aito.companyName')}
            </label>
            <input
              ref={firstFieldRef}
              id="panel-client-company"
              type="text"
              autoComplete="new-password"
              value={draft.companyName}
              onChange={(e) => update({ companyName: e.target.value })}
              className={fieldCls}
            />
          </div>
          {!isWalkIn && (
            <ContactPersonPicker
              contactId={project.client_id as string}
              value={draft.contactPersonId}
              preferredId={null}
              onSelect={selectPerson}
              variant="sheet"
            />
          )}
        </>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label htmlFor="panel-client-first-name" className={fieldLabelCls}>
              {t('aito.firstName')}
            </label>
            <input
              ref={firstFieldRef}
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
            <label htmlFor="panel-client-last-name" className={fieldLabelCls}>
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
        <label htmlFor="panel-client-phone" className={fieldLabelCls}>
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
            setEdited((v) => ({ ...v, phone: true }));
            if (changed === 'countryCode') setBlurred((b) => ({ ...b, phone: true }));
          }}
        />
        <FieldError messageKey={visibleErrors.phone} />
      </div>

      <div>
        <label htmlFor="panel-client-email" className={fieldLabelCls}>
          {t('aito.clientEmail')}
        </label>
        <input
          id="panel-client-email"
          type="email"
          autoComplete="new-password"
          value={draft.email}
          onChange={(e) => {
            update({ email: e.target.value });
            setEdited((v) => ({ ...v, email: true }));
          }}
          onBlur={() => setBlurred((b) => ({ ...b, email: true }))}
          placeholder={t('aito.emailPlaceholder')}
          aria-invalid={visibleErrors.email !== null ? true : undefined}
          className={visibleErrors.email !== null ? inputErrorCls : inputCls}
        />
        <FieldError messageKey={visibleErrors.email} />
      </div>

      {/* Network segment and handle on ONE row. The handle field is always
          in the tree but disabled until a network is picked — a username with
          no network is not a channel anyone can be reached on — and its
          placeholder says what to do first. Re-picking the chosen network
          clears both, which is the only way to remove the channel. */}
      <div>
        <span className={fieldLabelCls}>{t('aito.socialLabel')}</span>
        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
          <SocialSegment
            network={draft.socialNetwork}
            onChange={(network) => update({ socialNetwork: network, socialHandle: network === null ? '' : draft.socialHandle })}
          />
          <div className="relative">
            <label htmlFor="panel-client-social-handle" className="sr-only">
              {t('aito.socialHandleLabel')}
            </label>
            <AtSign
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
              aria-hidden="true"
            />
            <input
              id="panel-client-social-handle"
              type="text"
              autoComplete="off"
              disabled={draft.socialNetwork === null}
              value={draft.socialHandle}
              onChange={(e) => update({ socialHandle: e.target.value })}
              placeholder={draft.socialNetwork === null ? t('aito.socialPickFirst') : t('aito.socialHandlePlaceholder')}
              className={`${fieldCls} pl-9`}
            />
          </div>
        </div>
      </div>

      {!reachable && <p className="text-xs text-bambu-gray">{t('aito.ruleClientContact')}</p>}
      {error && <p className="text-sm text-status-error">{error}</p>}

      <div className="flex items-center justify-between gap-2.5 pt-0.5">
        {/* What else the save touches. Only a Books contact fans out to the
            client's other open cards; a walk-in edit stays on this card and
            the notice above already says so. */}
        <span className="flex min-w-0 items-center gap-1.5 text-[.76rem] text-bambu-gray">
          {!isWalkIn && (
            <>
              <Cloud className="h-3 w-3 flex-shrink-0 text-bambu-green-light" aria-hidden="true" />
              {isCompany && draft.contactPersonId ? t('aito.clientEditFanOutPerson') : t('aito.clientEditFanOut')}
            </>
          )}
        </span>
        <span className="flex flex-shrink-0 gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className={`rounded-lg px-3 py-1.5 text-sm text-bambu-gray-light transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`rounded-lg bg-bambu-green px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-bambu-green-light disabled:opacity-50 ${focusRingCls}`}
          >
            {t('common.save')}
          </button>
        </span>
      </div>
    </form>
  );
}
