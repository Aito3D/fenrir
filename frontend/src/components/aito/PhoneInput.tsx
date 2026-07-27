import { useTranslation } from 'react-i18next';
import { SearchableSelect } from '../SearchableSelect';
import { COUNTRY_CODES } from '../../utils/countryCodes';
import { inputCls, inputErrorCls } from '../formStyles';

export interface PhoneInputProps {
  countryCode: string;
  nationalNumber: string;
  onChange: (next: { countryCode: string; nationalNumber: string }) => void;
  onBlur?: (next: { countryCode: string; nationalNumber: string }) => void;
  invalid?: boolean;
  id?: string;
  disabled?: boolean;
}

const options = COUNTRY_CODES.map((c) => ({ value: c.code, label: `${c.code} ${c.name}` }));

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
          onChange={(next) => onChange({ countryCode: next, nationalNumber })}
          options={options}
          allowCustom
          disabled={disabled}
        />
      </div>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        disabled={disabled}
        value={nationalNumber}
        onChange={(e) => onChange({ countryCode, nationalNumber: e.target.value })}
        onBlur={(e) => {
          const next = { countryCode, nationalNumber: e.target.value.replace(/\D/g, '') };
          onChange(next);
          onBlur?.(next);
        }}
        placeholder={t('aito.phonePlaceholder')}
        aria-invalid={invalid ? true : undefined}
        className={invalid ? inputErrorCls : inputCls}
      />
    </div>
  );
}
