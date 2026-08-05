import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { IslandCombobox } from './IslandCombobox';
import { PhoneInput } from './PhoneInput';
import { FieldError } from './FieldError';
import { visibleShippingDraftErrors } from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';
import type { AitoShippingService } from '../../api/client';
import { titleCaseSegments } from '../../utils/clientDraft';
import { focusRingCls, inputCls, inputErrorCls, labelCls } from '../formStyles';

export interface ShippingFieldsProps {
  value: ShippingDraft;
  onChange: (next: ShippingDraft) => void;
  services: AitoShippingService[];
  catalogueResolved: boolean;
  currency: string;
}

/** The four shipping fields plus the service the island resolves to.
 *
 *  Shared verbatim by the create drawer and the detail panel's edit mode, so
 *  the two surfaces cannot drift on what a shipment is or when it is valid.
 *  It owns no state: the draft lives in the caller, which is what lets the
 *  drawer persist it to localStorage and the panel diff it against the server.
 *
 *  Picking an island is one atomic action, so it reveals its own errors at
 *  once and seeds the price from the service's Zoho rate — but only while the
 *  price has NOT been hand-edited, or changing island would silently discard a
 *  figure the operator typed on purpose. */
export function ShippingFields({ value, onChange, services, catalogueResolved, currency }: ShippingFieldsProps) {
  const { t } = useTranslation();
  const errors = visibleShippingDraftErrors(value);
  const service = services.find((s) => s.key === value.service);
  const zohoRate = service?.rate ?? null;

  const selectIsland = (islandKey: string) => {
    const owner = services.find((s) => s.islands.some((island) => island.key === islandKey));
    onChange({
      ...value,
      island: islandKey,
      service: owner?.key ?? '',
      price: value.priceEdited ? value.price : (owner?.rate ?? null),
      blurred: { ...value.blurred, island: true },
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <IslandCombobox
          value={value.island}
          services={services}
          onSelect={selectIsland}
          invalid={errors.island !== null}
          onBlur={() => onChange({ ...value, blurred: { ...value.blurred, island: true } })}
        />
        <FieldError messageKey={errors.island} />
      </div>

      {service && (
        <div className="flex items-center gap-3 rounded-lg border border-sky-400/30 bg-sky-400/[0.07] px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{service.name}</p>
            {zohoRate !== null ? (
              <p className="text-xs text-bambu-gray">
                {t('aito.shippingRateFromZoho', { rate: `${zohoRate.toLocaleString()} ${currency}` })}
              </p>
            ) : (
              <p className="text-xs text-amber-400">{t('aito.shippingNoRate')}</p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor="aito-shipping-rate" className="sr-only">
              {t('aito.shippingRate')}
            </label>
            <input
              id="aito-shipping-rate"
              type="number"
              min={0}
              inputMode="numeric"
              value={value.price ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  price: e.target.value === '' ? null : Number(e.target.value),
                  // Sticky: once the operator has taken the price over, a later
                  // island change must not quietly overwrite it.
                  priceEdited: true,
                })
              }
              className={`${inputCls} w-28 text-right`}
            />
            {value.priceEdited && (
              <span className="text-[11px] italic text-bambu-gray">{t('aito.shippingRateEdited')}</span>
            )}
            {value.priceEdited && zohoRate !== null && (
              <button
                type="button"
                aria-label={t('aito.shippingRateReset')}
                title={t('aito.shippingRateReset')}
                onClick={() => onChange({ ...value, price: zohoRate, priceEdited: false })}
                className={`rounded-md p-1.5 text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="aito-shipping-first" className={labelCls}>
            {t('aito.shippingFirstName')}
          </label>
          <input
            id="aito-shipping-first"
            type="text"
            value={value.firstName}
            onChange={(e) => onChange({ ...value, firstName: e.target.value })}
            onBlur={(e) =>
              onChange({
                ...value,
                // Hand-typed names get the same casing convention contact-derived
                // ones already carry (formatDisplayName): title-case given names,
                // upper-case family name. shippingDraft.ts stays pure and leaves
                // this to the field, matching NewContactForm's onBlur handler.
                firstName: titleCaseSegments(e.target.value),
                blurred: { ...value.blurred, firstName: true },
              })
            }
            aria-invalid={errors.firstName !== null ? true : undefined}
            className={errors.firstName ? inputErrorCls : inputCls}
          />
          <FieldError messageKey={errors.firstName} />
        </div>
        <div>
          <label htmlFor="aito-shipping-last" className={labelCls}>
            {t('aito.shippingLastName')}
          </label>
          <input
            id="aito-shipping-last"
            type="text"
            value={value.lastName}
            onChange={(e) => onChange({ ...value, lastName: e.target.value })}
            onBlur={(e) =>
              onChange({
                ...value,
                lastName: e.target.value.trim().toLocaleUpperCase('fr'),
                blurred: { ...value.blurred, lastName: true },
              })
            }
            aria-invalid={errors.lastName !== null ? true : undefined}
            className={errors.lastName ? inputErrorCls : inputCls}
          />
          <FieldError messageKey={errors.lastName} />
        </div>
      </div>

      <div>
        <label htmlFor="aito-shipping-phone" className={labelCls}>
          {t('aito.shippingPhone')}
        </label>
        <PhoneInput
          id="aito-shipping-phone"
          countryCode={value.countryCode}
          nationalNumber={value.nationalNumber}
          required
          invalid={errors.phone !== null}
          onChange={(next, changed) =>
            onChange({
              ...value,
              ...next,
              // Picking a code is one atomic action, so it reveals at once;
              // a keystroke in the number must not. Same split PhoneInput's
              // other callers make.
              blurred: changed === 'countryCode' ? { ...value.blurred, phone: true } : value.blurred,
            })
          }
          onBlur={(next) => onChange({ ...value, ...next, blurred: { ...value.blurred, phone: true } })}
        />
        <FieldError messageKey={errors.phone} />
      </div>

      {!catalogueResolved && <p className="text-xs text-amber-400">{t('aito.shippingUnavailable')}</p>}
    </div>
  );
}
