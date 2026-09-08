import { useTranslation } from 'react-i18next';
import { ChevronDown, Globe } from 'lucide-react';
import { availableLanguages } from '../../i18n';

/** The language pill in the card's top-right corner. The visible pill —
 *  globe, the language's own name from `sm:` up, a chevron — is drawn by
 *  us; a native <select> sits transparently over it, so the control stays
 *  keyboard-friendly, screen-reader-labelled and opens the system picker on
 *  a phone with no menu code. Below `sm:` the name is dropped: on a
 *  390 px card the pill would otherwise run into the centred logo. Names,
 *  not flags: a flag stands for a country, and a language has many. */
export function TrackingLanguageSelect() {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  const name = availableLanguages.find((l) => l.code === current)?.nativeName ?? current;
  return (
    <div className="absolute right-[16px] top-[16px] inline-flex h-[32px] items-center gap-[6px] rounded-full border border-aito-line bg-aito-card pl-[10px] pr-[8px] text-[12px] font-semibold text-aito-muted transition-[color,border-color,transform] duration-150 hover:border-aito-muted/60 hover:text-aito-ink active:scale-[0.97] focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-aito-cyan">
      <Globe className="h-[14px] w-[14px] shrink-0" aria-hidden="true" />
      <span className="hidden max-w-[120px] truncate sm:inline" aria-hidden="true">
        {name}
      </span>
      <ChevronDown className="h-[13px] w-[13px] shrink-0" aria-hidden="true" />
      <select
        data-testid="track-language"
        aria-label={t('aito.track.language')}
        value={current}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      >
        {availableLanguages.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.nativeName}
          </option>
        ))}
      </select>
    </div>
  );
}
