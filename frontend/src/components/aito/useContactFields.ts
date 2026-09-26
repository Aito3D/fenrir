import { useState } from 'react';
import {
  DEFAULT_COUNTRY_CODE,
  maskVisibleErrors,
  titleCaseSegments,
  upperCaseName,
  validateEmail,
  validatePhone,
} from '../../utils/clientDraft';
import type { ClientDraftErrors, ParsedPhone } from '../../utils/clientDraft';

export interface UseContactFieldsOptions {
  /** Called on every keystroke in the first name, last name, phone or email
   *  field. AddContactForm (ContactPersonPicker) passes `() => setError(null)`,
   *  so a failed-create message there clears the instant any field is touched;
   *  NewContactForm passes nothing and keeps its message until the next submit.
   *  That divergence is PRE-EXISTING — the hook only carries it, it does not
   *  pick a winner. */
  onFieldChange?: () => void;
}

/** The first/last-name + phone + email capture that NewContactForm (the
 *  new-project drawer's create-contact step) and AddContactForm (the contact
 *  picker's inline add form) both need: the field state, the blur casing, the
 *  phone/email validation, the "only report an error once the field has been
 *  left" masking, and the phone-or-email reachability gate.
 *
 *  Casing is normalized on blur rather than per keystroke — per-keystroke
 *  fights hyphenated names like "Jean-Pierre" while they are still being
 *  typed — and re-applied server-side either way.
 *
 *  What is NOT here, because the two forms genuinely differ: the name
 *  requirement (both names, or a company, versus a first name alone), the
 *  social channel, the submit mutation, and the error message state. Each form
 *  composes `canSubmit` from `errorsClear` / `reachable` plus its own rule. */
export function useContactFields({ onFieldChange }: UseContactFieldsOptions = {}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE);
  const [nationalNumber, setNationalNumber] = useState('');
  const [email, setEmail] = useState('');
  const [blurred, setBlurred] = useState({ phone: false, email: false });

  const phone: ParsedPhone = { countryCode, nationalNumber };
  const phoneError = validatePhone(phone);
  const emailError = validateEmail(email);
  const visibleErrors: ClientDraftErrors = maskVisibleErrors({ phone: phoneError, email: emailError }, blurred);

  return {
    firstName,
    lastName,
    email,
    countryCode,
    nationalNumber,
    phone,
    /** The names as they will be stored: what the blur handlers write back,
     *  computed live so a preview does not wait for a blur. */
    casedFirst: titleCaseSegments(firstName),
    casedLast: upperCaseName(lastName),
    phoneError,
    emailError,
    visibleErrors,
    /** At least one of the two Zoho-visible channels has something in it. */
    reachable: nationalNumber.replace(/\D/g, '') !== '' || email.trim() !== '',
    /** Nothing the user can SEE is wrong — the button gates on this, the
     *  submit handler on the raw `phoneError` / `emailError`, so a disabled
     *  button always has a message beside it. */
    errorsClear: visibleErrors.phone === null && visibleErrors.email === null,
    onFirstNameChange: (value: string) => {
      setFirstName(value);
      onFieldChange?.();
    },
    onFirstNameBlur: (value: string) => setFirstName(titleCaseSegments(value)),
    onLastNameChange: (value: string) => {
      setLastName(value);
      onFieldChange?.();
    },
    onLastNameBlur: (value: string) => setLastName(upperCaseName(value)),
    onEmailChange: (value: string) => {
      setEmail(value);
      onFieldChange?.();
    },
    onEmailBlur: () => setBlurred((b) => ({ ...b, email: true })),
    onPhoneChange: (next: ParsedPhone, changed: 'countryCode' | 'nationalNumber') => {
      setCountryCode(next.countryCode);
      setNationalNumber(next.nationalNumber);
      onFieldChange?.();
      // Picking a country code is one atomic action, so its error shows at
      // once; a national-number keystroke waits for the blur.
      if (changed === 'countryCode') setBlurred((b) => ({ ...b, phone: true }));
    },
    onPhoneBlur: () => setBlurred((b) => ({ ...b, phone: true })),
    /** Reveal anything the user never triggered by blurring. Called first in
     *  both submit handlers, which then re-check the RAW errors — the masked
     *  ones were computed before this state update lands. */
    revealErrors: () => setBlurred({ phone: true, email: true }),
  };
}
