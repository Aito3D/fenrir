import { describe, it, expect } from 'vitest';
import {
  parsePhone,
  formatPhone,
  titleCaseSegments,
  formatDisplayName,
  validateEmail,
  validatePhone,
  clientDraftErrors,
  draftFromContact,
  defaultClientDraft,
} from '../../utils/clientDraft';
import { COUNTRY_CODES, DEFAULT_COUNTRY_CODE } from '../../utils/countryCodes';

describe('countryCodes', () => {
  it('has unique dial codes and covers the codes present in the org data', () => {
    const codes = COUNTRY_CODES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of ['+689', '+687', '+33', '+47', '+1', '+64', '+61']) {
      expect(codes).toContain(code);
    }
    expect(COUNTRY_CODES.length).toBeGreaterThanOrEqual(200);
    expect(DEFAULT_COUNTRY_CODE).toBe('+689');
  });
});

describe('parsePhone', () => {
  it.each([
    ['+689-87296912', '+689', '87296912'],
    ['+33-0179753070', '+33', '0179753070'],
    ['+47-92296862', '+47', '92296862'],
    ['+3312345678', '+33', '12345678'],
    ['00.687.76.31.68', '+687', '763168'],
    ['40 54 43 09', '+689', '40544309'],
    ['87.30.73.53', '+689', '87307353'],
    ['89645864', '+689', '89645864'],
    ['0688727786', '+689', '0688727786'],
    ['', '+689', ''],
    ['   ', '+689', ''],
  ])('parses %s', (raw, countryCode, nationalNumber) => {
    expect(parsePhone(raw)).toEqual({ countryCode, nationalNumber });
  });

  it('honours an explicit default code', () => {
    expect(parsePhone('12345678', '+33')).toEqual({ countryCode: '+33', nationalNumber: '12345678' });
  });
});

describe('formatPhone', () => {
  it('joins with a single hyphen and preserves leading zeros', () => {
    expect(formatPhone({ countryCode: '+33', nationalNumber: '0179753070' })).toBe('+33-0179753070');
  });

  it('returns an empty string when there is no number', () => {
    expect(formatPhone({ countryCode: '+689', nationalNumber: '' })).toBe('');
  });

  it('round-trips a house-format number', () => {
    expect(formatPhone(parsePhone('+689-87296912'))).toBe('+689-87296912');
  });
});

describe('titleCaseSegments', () => {
  it.each([
    ['jean-pierre', 'Jean-Pierre'],
    ['MARIE anne', 'Marie Anne'],
    ['élodie', 'Élodie'],
    ['  paul  ', 'Paul'],
    ['', ''],
  ])('%s -> %s', (input, expected) => {
    expect(titleCaseSegments(input)).toBe(expected);
  });
});

describe('formatDisplayName', () => {
  it.each([
    ['jean-pierre', 'de la tour', 'Jean-Pierre DE LA TOUR'],
    ['élodie', 'teïva-marü', 'Élodie TEÏVA-MARÜ'],
    ['MARIE anne', 'Dupont', 'Marie Anne DUPONT'],
    ['paul', '', 'Paul'],
    ['', 'dupont', 'DUPONT'],
  ])('(%s, %s) -> %s', (first, last, expected) => {
    expect(formatDisplayName(first, last)).toBe(expected);
  });
});

describe('validateEmail', () => {
  it.each(['', '   ', 'a@b.pf', 'client@example.com', 'first.last+tag@sub.domain.co'])(
    'accepts %s',
    (value) => {
      expect(validateEmail(value)).toBeNull();
    },
  );

  it.each(['a', 'a@', '@b.pf', 'a@b', 'a b@c.pf', 'a@b.p'])('rejects %s', (value) => {
    expect(validateEmail(value)).toBe('aito.invalidEmail');
  });
});

describe('validatePhone', () => {
  it('accepts an empty number regardless of the code', () => {
    expect(validatePhone({ countryCode: '+689', nationalNumber: '' })).toBeNull();
  });

  it.each(['1234', '763138', '89645864', '01234567890123'])('accepts %s digits', (national) => {
    expect(validatePhone({ countryCode: '+689', nationalNumber: national })).toBeNull();
  });

  it.each(['123', '012345678901234'])('rejects %s', (national) => {
    expect(validatePhone({ countryCode: '+689', nationalNumber: national })).toBe('aito.invalidPhone');
  });

  it('rejects a malformed country code', () => {
    expect(validatePhone({ countryCode: '689', nationalNumber: '87123456' })).toBe(
      'aito.invalidCountryCode',
    );
    expect(validatePhone({ countryCode: '+', nationalNumber: '87123456' })).toBe(
      'aito.invalidCountryCode',
    );
  });

  it('does not flag the country code when the number is empty', () => {
    expect(validatePhone({ countryCode: '689', nationalNumber: '' })).toBeNull();
  });
});

describe('clientDraftErrors', () => {
  const bad = {
    ...defaultClientDraft('d1', 'Client de passage'),
    email: 'nope',
    nationalNumber: '12',
  };

  it('reports nothing while the fields are unblurred', () => {
    expect(clientDraftErrors(bad)).toEqual({ phone: null, email: null });
  });

  it('reports both once blurred', () => {
    expect(clientDraftErrors({ ...bad, blurred: { phone: true, email: true } })).toEqual({
      phone: 'aito.invalidPhone',
      email: 'aito.invalidEmail',
    });
  });

  it('reports only the blurred field', () => {
    expect(clientDraftErrors({ ...bad, blurred: { phone: false, email: true } })).toEqual({
      phone: null,
      email: 'aito.invalidEmail',
    });
  });
});

describe('draftFromContact', () => {
  const base = { id: 'z1', name: 'ACME SARL', company_name: 'ACME', phone: '', mobile: '', email: '' };

  it('prefers mobile and records it as the write target', () => {
    const draft = draftFromContact({ ...base, mobile: '89645864', phone: '40864225' }, 'default-id');
    expect(draft.countryCode).toBe('+689');
    expect(draft.nationalNumber).toBe('89645864');
    expect(draft.original).toEqual({ phone: '89645864', email: '', phoneField: 'mobile' });
    expect(draft.touched).toEqual({ phone: false, email: false });
    expect(draft.blurred).toEqual({ phone: false, email: false });
    expect(draft.isDefault).toBe(false);
  });

  it('falls back to phone and records phone as the write target', () => {
    const draft = draftFromContact({ ...base, phone: '+689-40864225' }, 'default-id');
    expect(draft.nationalNumber).toBe('40864225');
    expect(draft.original.phoneField).toBe('phone');
  });

  it('targets mobile when the contact has neither', () => {
    expect(draftFromContact(base, 'default-id').original.phoneField).toBe('mobile');
  });

  it('flags the default contact', () => {
    expect(draftFromContact({ ...base, id: 'default-id' }, 'default-id').isDefault).toBe(true);
  });
});

describe('defaultClientDraft', () => {
  it('is empty, untouched and flagged as default', () => {
    expect(defaultClientDraft('d1', 'Client de passage')).toEqual({
      id: 'd1',
      name: 'Client de passage',
      isDefault: true,
      countryCode: '+689',
      nationalNumber: '',
      email: '',
      touched: { phone: false, email: false },
      blurred: { phone: false, email: false },
      original: { phone: '', email: '', phoneField: 'mobile' },
    });
  });
});
