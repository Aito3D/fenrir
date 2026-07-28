import { useTranslation } from 'react-i18next';
import { SearchableSelect } from '../SearchableSelect';
import { COUNTRY_CODES } from '../../utils/countryCodes';
import { inputCls, inputErrorCls } from '../formStyles';

export interface PhoneInputProps {
  countryCode: string;
  nationalNumber: string;
  // `changed` tells the caller which half fired: 'countryCode' lets ClientSection
  // and NewContactForm reveal a resulting error immediately (picking a code is one
  // atomic action, so blurring separately makes no sense) without doing the same
  // for every national-number keystroke, which would break the blur-then-live
  // validation timing the rest of the form uses.
  onChange: (next: { countryCode: string; nationalNumber: string }, changed: 'countryCode' | 'nationalNumber') => void;
  onBlur?: (next: { countryCode: string; nationalNumber: string }) => void;
  invalid?: boolean;
  /** Sets aria-required on the national-number input. The country code always
   *  has a value, so the requirement only concerns the number. */
  required?: boolean;
  id?: string;
  disabled?: boolean;
}

const options = COUNTRY_CODES.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` }));

// What a country code can look like mid-entry: an optional leading '+' and up
// to 4 digits. `SearchableSelect` with `allowCustom` fires its onChange on
// every keystroke, including free-text searches like "France" — this is the
// gate that stops that free text from ever reaching the draft. The picker's
// own `search` state (not this prop) is what the dropdown filters against, so
// filtering here never blocks typing or searching the list.
const COUNTRY_CODE_INPUT_RE = /^\+?\d{0,4}$/;

/** Dialling-code picker + national number. Zoho stores the whole thing as one
 *  free-text string, so this pair is only a UI split; `formatPhone` rejoins it
 *  as `+CC-XXXXXXXX`. Digits are stripped of separators on blur so the user
 *  sees exactly what will be stored. `allowCustom` lets an unlisted code
 *  through rather than blocking an unusual number. */
export function PhoneInput({
  countryCode,
  nationalNumber,
  onChange,
  onBlur,
  invalid,
  required,
  id,
  disabled,
}: PhoneInputProps) {
  const { t } = useTranslation();

  return (
    <div className="flex gap-2">
      <div className="w-36 flex-shrink-0">
        {/* SearchableSelect renders its own role="combobox" input, so it needs a
            real label of its own — otherwise it is a second, unnamed combobox
            sitting next to the client search. `id` lands on the inner input. */}
        <label htmlFor={`${id ?? 'aito-phone'}-country`} className="sr-only">
          {t('aito.countryCode')}
        </label>
        <SearchableSelect
          id={`${id ?? 'aito-phone'}-country`}
          value={countryCode}
          onChange={(next) => {
            if (!COUNTRY_CODE_INPUT_RE.test(next)) return;
            onChange({ countryCode: next, nationalNumber }, 'countryCode');
          }}
          options={options}
          allowCustom
          disabled={disabled}
        />
      </div>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="new-password"
        disabled={disabled}
        value={nationalNumber}
        onChange={(e) => onChange({ countryCode, nationalNumber: e.target.value }, 'nationalNumber')}
        onBlur={(e) => {
          const next = { countryCode, nationalNumber: e.target.value.replace(/\D/g, '') };
          onChange(next, 'nationalNumber');
          onBlur?.(next);
        }}
        placeholder={t('aito.phonePlaceholder')}
        aria-invalid={invalid ? true : undefined}
        aria-required={required ? true : undefined}
        className={invalid ? inputErrorCls : inputCls}
      />
    </div>
  );
}
