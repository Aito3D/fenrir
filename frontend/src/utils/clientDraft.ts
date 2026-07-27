import type { ZohoContact } from '../api/client';
import { COUNTRY_CODES, DEFAULT_COUNTRY_CODE } from './countryCodes';

export interface ParsedPhone {
  countryCode: string;
  nationalNumber: string;
}

/** The client half of the Aito new-project form, as one value.
 *
 *  `touched` tracks user intent, not a value diff: a contact stored as a bare
 *  `89645864` renders as `[+689][89645864]`, which re-formats to a different
 *  string than Zoho holds. Keying "dirty" off the value would rewrite hundreds
 *  of untouched contacts as a side effect of creating a card. */
export interface ClientDraft {
  id: string;
  name: string;
  /** The shared walk-in contact — its phone/email are card-only, never synced. */
  isDefault: boolean;
  countryCode: string;
  nationalNumber: string;
  email: string;
  touched: { phone: boolean; email: boolean };
  /** Has the field been left once? Gates error *visibility* only — reusing
   *  `touched` would flash the error from the first keystroke. */
  blurred: { phone: boolean; email: boolean };
  original: { phone: string; email: string; phoneField: 'phone' | 'mobile' };
}

export interface ClientDraftErrors {
  phone: string | null;
  email: string | null;
}

const digitsOnly = (value: string) => value.replace(/\D/g, '');

// Longest first, so '+689' wins over '+6' and '+33' over '+3'.
const CODES_BY_LENGTH = [...COUNTRY_CODES]
  .map((c) => c.code)
  .sort((a, b) => b.length - a.length);

/** Split a stored Zoho phone string into a dialling code and a national number.
 *  Zoho stores the whole thing as free text — `mobile_country_code` is unused —
 *  so the prefix has to be recovered from the string itself. */
export function parsePhone(raw: string, defaultCode: string = DEFAULT_COUNTRY_CODE): ParsedPhone {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { countryCode: defaultCode, nationalNumber: '' };

  let rest: string | null = null;
  if (trimmed.startsWith('+')) rest = trimmed.slice(1);
  else if (trimmed.startsWith('00')) rest = trimmed.slice(2);

  if (rest === null) return { countryCode: defaultCode, nationalNumber: digitsOnly(trimmed) };

  const hyphen = rest.indexOf('-');
  if (hyphen > 0) {
    return {
      countryCode: `+${digitsOnly(rest.slice(0, hyphen))}`,
      nationalNumber: digitsOnly(rest.slice(hyphen + 1)),
    };
  }

  const digits = digitsOnly(rest);
  const match = CODES_BY_LENGTH.find((code) => digits.startsWith(code.slice(1)));
  if (!match) return { countryCode: defaultCode, nationalNumber: digits };
  return { countryCode: match, nationalNumber: digits.slice(match.length - 1) };
}

/** House format: `+CC-XXXXXXXX`. Leading zeros are kept — `+33-0179753070`
 *  is a real, correct value in the directory. */
export function formatPhone(phone: ParsedPhone): string {
  const national = digitsOnly(phone.nationalNumber);
  return national ? `${phone.countryCode}-${national}` : '';
}

/** Capitalize every space- or hyphen-separated segment: 'jean-pierre' -> 'Jean-Pierre'. */
export function titleCaseSegments(value: string): string {
  return value
    .trim()
    .split(/([ -]+)/)
    .map((part, index) =>
      index % 2
        ? part
        : part.slice(0, 1).toLocaleUpperCase('fr') + part.slice(1).toLocaleLowerCase('fr'),
    )
    .join('');
}

/** House convention for person contacts: 'Jean-Pierre DUPONT'. */
export function formatDisplayName(firstName: string, lastName: string): string {
  return `${titleCaseSegments(firstName)} ${lastName.trim().toLocaleUpperCase('fr')}`.trim();
}

// Shape check only. A stricter pattern rejects real addresses; the authority on
// deliverability is Zoho, not this regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COUNTRY_CODE_RE = /^\+\d{1,4}$/;
const MIN_NATIONAL_DIGITS = 4;
const MAX_NATIONAL_DIGITS = 14; // E.164 caps a full number at 15; the code takes 1-4

/** Both fields are optional, so empty always passes. Returns an i18n key rather
 *  than a rendered string so this stays pure and testable without i18n. */
export function validateEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return EMAIL_RE.test(trimmed) ? null : 'aito.invalidEmail';
}

export function validatePhone(phone: ParsedPhone): string | null {
  const national = digitsOnly(phone.nationalNumber);
  // No number means no phone at all — an odd leftover country code is harmless.
  if (!national) return null;
  if (!COUNTRY_CODE_RE.test(phone.countryCode)) return 'aito.invalidCountryCode';
  if (national.length < MIN_NATIONAL_DIGITS || national.length > MAX_NATIONAL_DIGITS) {
    return 'aito.invalidPhone';
  }
  return null;
}

/** Single source of truth for what the form shows and whether it may submit.
 *  A field that has never been blurred reports no error, so opening a contact
 *  whose stored value is already malformed stays quiet. */
export function clientDraftErrors(draft: ClientDraft): ClientDraftErrors {
  return {
    phone: draft.blurred.phone
      ? validatePhone({ countryCode: draft.countryCode, nationalNumber: draft.nationalNumber })
      : null,
    email: draft.blurred.email ? validateEmail(draft.email) : null,
  };
}

export function draftFromContact(contact: ZohoContact, defaultContactId: string): ClientDraft {
  const phoneField: 'phone' | 'mobile' = contact.mobile ? 'mobile' : contact.phone ? 'phone' : 'mobile';
  const raw = contact.mobile || contact.phone || '';
  const parsed = parsePhone(raw);
  return {
    id: contact.id,
    name: contact.name,
    isDefault: contact.id === defaultContactId,
    countryCode: parsed.countryCode,
    nationalNumber: parsed.nationalNumber,
    email: contact.email ?? '',
    touched: { phone: false, email: false },
    blurred: { phone: false, email: false },
    original: { phone: raw, email: contact.email ?? '', phoneField },
  };
}

/** The default client is known from settings alone — id and name, nothing else. */
export function defaultClientDraft(id: string, name: string): ClientDraft {
  return {
    id,
    name,
    isDefault: true,
    countryCode: DEFAULT_COUNTRY_CODE,
    nationalNumber: '',
    email: '',
    touched: { phone: false, email: false },
    blurred: { phone: false, email: false },
    original: { phone: '', email: '', phoneField: 'mobile' },
  };
}

export { DEFAULT_COUNTRY_CODE } from './countryCodes';
