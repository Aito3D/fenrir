import { useTranslation } from 'react-i18next';
import { AtSign, Instagram, MessageCircle, MessageSquare, Music2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SOCIAL_NETWORKS } from '../../utils/clientDraft';
import type { SocialNetwork } from '../../utils/clientDraft';
import { focusRingCls, inputCls, labelCls } from '../formStyles';

/** Lucide ships no Messenger, WhatsApp or TikTok brand glyph, so these are the
 *  nearest generic marks. Exported with the label keys below because the detail
 *  panel renders the same pair for a stored handle — a second copy there would
 *  drift the moment a network is added. */
export const SOCIAL_ICONS: Record<SocialNetwork, LucideIcon> = {
  messenger: MessageCircle,
  instagram: Instagram,
  whatsapp: MessageSquare,
  tiktok: Music2,
};

export const SOCIAL_LABEL_KEYS: Record<SocialNetwork, string> = {
  messenger: 'aito.socialNetworkMessenger',
  instagram: 'aito.socialNetworkInstagram',
  whatsapp: 'aito.socialNetworkWhatsapp',
  tiktok: 'aito.socialNetworkTiktok',
};

export interface SocialInputProps {
  /** Prefix for the input id, so both mount sites (ClientSection and
   *  NewContactForm) can be on screen without colliding label targets. */
  idPrefix: string;
  network: SocialNetwork | null;
  handle: string;
  onChange: (next: { network: SocialNetwork | null; handle: string }) => void;
}

/** The optional third contact channel: pick a network, then type a username.
 *
 *  The handle input does not exist until a network is chosen — a username with
 *  no network is not a channel anyone can be reached on, and the backend
 *  rejects that pair outright, so the UI never lets it be formed.
 *
 *  Picking the SELECTED network again clears both fields. That is the only way
 *  back out, which is why it is a radio group rather than a set of toggles: a
 *  "none" state exists, but it is the absence of a selection, not a fifth pill.
 *
 *  Deliberately no validation beyond "non-empty" (enforced by the callers'
 *  reachability rule, not here): a WhatsApp handle is a phone number and an
 *  Instagram one is not. */
export function SocialInput({ idPrefix, network, handle, onChange }: SocialInputProps) {
  const { t } = useTranslation();
  const handleId = `${idPrefix}-social-handle`;

  return (
    <div>
      <span className={labelCls}>{t('aito.socialLabel')}</span>
      <div role="radiogroup" aria-label={t('aito.socialLabel')} className="grid grid-cols-4 gap-1.5">
        {SOCIAL_NETWORKS.map((id) => {
          const Icon = SOCIAL_ICONS[id];
          const selected = network === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              // Re-picking the selection is the clear gesture; the handle goes
              // with it, because a handle belonging to no network is exactly
              // the pair the server refuses.
              onClick={() => onChange(selected ? { network: null, handle: '' } : { network: id, handle })}
              // Hover text only on the selected pill, saying what clicking it
              // again does. A `title` never displaces the accessible name while
              // the button has text content, so the pill is still reachable as
              // "Instagram" either way — the name must not change with state or
              // a user looking for the network they picked could not find it.
              title={selected ? t('aito.socialRemove') : undefined}
              className={`flex flex-col items-center gap-1 rounded-[.6rem] border px-2 py-2 text-[11px] font-semibold transition-colors ${focusRingCls} ${
                selected
                  ? 'border-bambu-green/60 bg-bambu-green/10 text-bambu-green'
                  : 'border-bambu-dark-tertiary text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span className="truncate">{t(SOCIAL_LABEL_KEYS[id])}</span>
            </button>
          );
        })}
      </div>

      {network !== null && (
        // animate-rise: the input arrives in response to the pick just above
        // it, the same bridge the shipping block uses when it expands.
        <div className="animate-rise mt-2">
          <label htmlFor={handleId} className={labelCls}>
            {t('aito.socialHandleLabel')}
          </label>
          <div className="relative">
            <AtSign
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray"
              aria-hidden="true"
            />
            <input
              id={handleId}
              type="text"
              autoComplete="off"
              value={handle}
              onChange={(e) => onChange({ network, handle: e.target.value })}
              placeholder={t('aito.socialHandlePlaceholder')}
              // pl-9 clears the glyph. `inputCls` already carries `w-full`, so
              // no width class is added here — a second width would silently
              // lose to it.
              className={`${inputCls} pl-9`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
