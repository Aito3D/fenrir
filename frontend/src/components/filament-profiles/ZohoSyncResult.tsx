import { useTranslation } from 'react-i18next';

import type { FilamentPresetZohoSyncAttention, FilamentPresetZohoSyncResponse } from '../../api/client';

// T-003: exhaustive lookup for zohoResult.attention reason -> i18n key. Keying
// this on the `reason` union (rather than a ternary/switch fallthrough) means
// TypeScript errors if the union ever grows another value instead of silently
// reusing a fallback translation.
const ZOHO_ATTENTION_REASON_KEYS: Record<FilamentPresetZohoSyncAttention['reason'], string> = {
  no_match: 'filamentProfiles.syncZohoNoMatch',
  ambiguous: 'filamentProfiles.syncZohoAmbiguous',
  unwritable_content: 'filamentProfiles.syncZohoUnwritable',
  bad_price: 'filamentProfiles.syncZohoBadPrice',
  weight_unknown: 'filamentProfiles.syncZohoWeightUnknown',
  content_too_large: 'filamentProfiles.syncZohoContentTooLarge',
  no_price: 'filamentProfiles.syncZohoNoPrice',
};

/** Breakdown of the last Zoho price sync: what was priced and which profiles need attention. */
export function ZohoSyncResult({ zohoResult }: { zohoResult: FilamentPresetZohoSyncResponse }) {
  const { t } = useTranslation();
  return (
      <div className="mb-4 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-3 text-sm">
        <div className="text-white">
          {t('filamentProfiles.syncZohoDone', { priced: zohoResult.priced, unchanged: zohoResult.unchanged })}
        </div>
        {zohoResult.catalogue_stale_since && (
          <div className="mt-2 text-amber-400">
            {t('filamentProfiles.syncZohoStale', {
              timestamp: new Date(zohoResult.catalogue_stale_since).toLocaleString(),
            })}
          </div>
        )}
        {zohoResult.attention.length > 0 && (
          <>
            <div className="mt-2 text-bambu-gray-light">
              {t('filamentProfiles.syncZohoAttention', { count: zohoResult.attention_total })}
            </div>
            <ul className="mt-1 space-y-0.5 text-bambu-gray-light">
              {zohoResult.attention.map((entry) => (
                <li key={entry.id}>
                  <span className="text-white">{entry.name}</span>
                  {' — '}
                  {t(ZOHO_ATTENTION_REASON_KEYS[entry.reason])}
                  {entry.candidates.length > 0 && (
                    <>
                      {': '}
                      {entry.candidates.join(', ')}
                      {entry.candidates_total > entry.candidates.length &&
                        ` ${t('common.plusNMore', { count: entry.candidates_total - entry.candidates.length })}`}
                    </>
                  )}
                </li>
              ))}
            </ul>
            {zohoResult.attention_total > zohoResult.attention.length && (
              <div className="mt-1 text-bambu-gray-light">
                {t('common.plusNMore', { count: zohoResult.attention_total - zohoResult.attention.length })}
              </div>
            )}
          </>
        )}
      </div>
  );
}
