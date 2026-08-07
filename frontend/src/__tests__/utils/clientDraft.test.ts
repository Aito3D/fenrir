import { describe, it, expect } from 'vitest';
import {
  parsePhone,
  formatPhone,
  formatPhoneDisplay,
  titleCaseSegments,
  formatDisplayName,
  validateEmail,
  validatePhone,
  clientDraftErrors,
  maskVisibleErrors,
  visibleClientDraftErrors,
  draftFromContact,
  defaultClientDraft,
  isSocialNetwork,
  normaliseClientDraft,
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

describe('formatPhoneDisplay', () => {
  it('renders the house format as (+CC) with dot-separated digit pairs', () => {
    expect(formatPhoneDisplay('+689-87755669')).toBe('(+689) 87.75.56.69');
  });

  it('keeps leading zeros and handles longer national numbers', () => {
    expect(formatPhoneDisplay('+33-0179753070')).toBe('(+33) 01.79.75.30.70');
  });

  it('falls back to the default country code for a bare number', () => {
    expect(formatPhoneDisplay('89645864')).toBe('(+689) 89.64.58.64');
  });

  it('leaves a trailing single digit as its own group', () => {
    expect(formatPhoneDisplay('+689-8775566')).toBe('(+689) 87.75.56.6');
  });

  it('returns an empty string for blank input', () => {
    expect(formatPhoneDisplay('')).toBe('');
    expect(formatPhoneDisplay('   ')).toBe('');
  });

  it('passes a digitless free-text value through instead of blanking it', () => {
    // Zoho stores the phone as free text. Formatting these to '' would render
    // an icon with nothing beside it, because `display ?? value` in
    // CopyableValue does not fall through on an empty string.
    expect(formatPhoneDisplay('à confirmer')).toBe('à confirmer');
    expect(formatPhoneDisplay('  bureau  ')).toBe('bureau');
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
  // Pure validity — independent of `blurred`. This is the source of a bug fixed
  // in the final review: an earlier version of this function folded the
  // `blurred` mask in here directly, which meant the only way for a caller to
  // check "is this draft submittable" was to fabricate a fully-blurred copy —
  // and that copy is what NewProjectModal used to disable "Create project" the
  // instant a contact with an already-malformed *stored* phone/email was
  // selected, with no error on screen to explain why. Splitting validity
  // (this function) from visibility (`maskVisibleErrors`) lets a caller gate
  // submit on visible errors instead, so a disabled button always has a
  // message beside it.
  const bad = {
    ...defaultClientDraft('d1', 'Client de passage'),
    email: 'nope',
    nationalNumber: '12',
  };

  it('reports validity regardless of whether the fields have been blurred', () => {
    expect(clientDraftErrors(bad)).toEqual({ phone: 'aito.invalidPhone', email: 'aito.invalidEmail' });
    expect(clientDraftErrors({ ...bad, blurred: { phone: true, email: true } })).toEqual({
      phone: 'aito.invalidPhone',
      email: 'aito.invalidEmail',
    });
  });

  it('reports nothing for a valid draft', () => {
    expect(clientDraftErrors(defaultClientDraft('d1', 'Client de passage'))).toEqual({
      phone: null,
      email: null,
    });
  });
});

describe('maskVisibleErrors', () => {
  const errors = { phone: 'aito.invalidPhone', email: 'aito.invalidEmail' };

  it('hides both while nothing has been blurred', () => {
    expect(maskVisibleErrors(errors, { phone: false, email: false })).toEqual({ phone: null, email: null });
  });

  it('reveals only the blurred field', () => {
    expect(maskVisibleErrors(errors, { phone: false, email: true })).toEqual({
      phone: null,
      email: 'aito.invalidEmail',
    });
  });

  it('reveals both once both are blurred', () => {
    expect(maskVisibleErrors(errors, { phone: true, email: true })).toEqual(errors);
  });
});

describe('visibleClientDraftErrors', () => {
  const bad = {
    ...defaultClientDraft('d1', 'Client de passage'),
    email: 'nope',
    nationalNumber: '12',
  };

  it('reports nothing while the fields are unblurred, even though the draft is invalid', () => {
    // The exact scenario from the review: `draftFromContact` can hand back a
    // draft whose stored value is already malformed. Opening it must never
    // flag work the user didn't do.
    expect(visibleClientDraftErrors(bad)).toEqual({ phone: null, email: null });
    expect(clientDraftErrors(bad)).not.toEqual({ phone: null, email: null });
  });

  it('reports both once blurred', () => {
    expect(visibleClientDraftErrors({ ...bad, blurred: { phone: true, email: true } })).toEqual({
      phone: 'aito.invalidPhone',
      email: 'aito.invalidEmail',
    });
  });

  it('reports only the blurred field', () => {
    expect(visibleClientDraftErrors({ ...bad, blurred: { phone: false, email: true } })).toEqual({
      phone: null,
      email: 'aito.invalidEmail',
    });
  });
});

describe('draftFromContact', () => {
  const base = {
    id: 'z1',
    name: 'ACME SARL',
    company_name: 'ACME',
    customer_sub_type: 'business',
    phone: '',
    mobile: '',
    email: '',
  };

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

  it.each([
    ['business', true],
    ['individual', false],
    ['', false],
    ['something-else', false],
  ])('maps customer_sub_type %s to isCompany %s', (subType, expected) => {
    expect(draftFromContact({ ...base, customer_sub_type: subType }, 'default-id').isCompany).toBe(expected);
  });
});

describe('defaultClientDraft', () => {
  it('is empty, untouched and flagged as default', () => {
    expect(defaultClientDraft('d1', 'Client de passage')).toEqual({
      id: 'd1',
      name: 'Client de passage',
      isDefault: true,
      isCompany: false,
      countryCode: '+689',
      nationalNumber: '',
      email: '',
      socialNetwork: null,
      socialHandle: '',
      touched: { phone: false, email: false },
      blurred: { phone: false, email: false },
      original: { phone: '', email: '', phoneField: 'mobile' },
    });
  });
});

describe('social network on the draft', () => {
  it('defaults to no social channel', () => {
    const draft = defaultClientDraft('default-id', 'Walk-in');
    expect(draft.socialNetwork).toBeNull();
    expect(draft.socialHandle).toBe('');
  });

  it('starts a contact-seeded draft with no social channel, since Zoho holds none', () => {
    const draft = draftFromContact(
      {
        id: 'c1',
        name: 'Moana',
        email: 'moana@example.com',
        phone: '',
        mobile: '+689-87123456',
        customer_sub_type: 'individual',
      } as never,
      'default-id',
    );
    expect(draft.socialNetwork).toBeNull();
    expect(draft.socialHandle).toBe('');
  });

  it('recognises exactly the four supported networks', () => {
    expect(isSocialNetwork('instagram')).toBe(true);
    expect(isSocialNetwork('messenger')).toBe(true);
    expect(isSocialNetwork('whatsapp')).toBe(true);
    expect(isSocialNetwork('tiktok')).toBe(true);
    expect(isSocialNetwork('myspace')).toBe(false);
    expect(isSocialNetwork(undefined)).toBe(false);
  });

  it('fills the social fields on a draft written before they existed', () => {
    const legacy = { ...defaultClientDraft('default-id', 'Walk-in') } as Record<string, unknown>;
    delete legacy.socialNetwork;
    delete legacy.socialHandle;
    const repaired = normaliseClientDraft(legacy as never);
    expect(repaired.socialNetwork).toBeNull();
    expect(repaired.socialHandle).toBe('');
  });

  it('drops a network a newer build might have written, and the handle with it', () => {
    // The pairing invariant is atomic everywhere else — a half-pair surviving
    // here would enable Create only for the server to 422 it, with the
    // orphaned handle invisible until a pill click.
    const draft = {
      ...defaultClientDraft('default-id', 'Walk-in'),
      socialNetwork: 'myspace',
      socialHandle: 'moana.3d',
    };
    const repaired = normaliseClientDraft(draft as never);
    expect(repaired.socialNetwork).toBeNull();
    expect(repaired.socialHandle).toBe('');
  });
});
