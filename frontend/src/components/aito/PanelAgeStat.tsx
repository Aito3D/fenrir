import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import { ageAnchor, agingColorCls } from '../../utils/aitoAging';
import { formatElapsedTime } from '../../utils/date';
import { eyebrowCls } from './panelTypography';

/** Age as a header metric, paired with the money cluster behind its own
 *  divider: money is how much, age is how long, and those are the two facts
 *  that decide whether a project gets opened today.
 *
 *  Same anchor and same ramp as the board card (utils/aitoAging), plus the one
 *  thing a 260px card has no room for — the anchor's NAME. Without it, the
 *  same "12 days ago" measures acceptance on one project and creation on the
 *  next, and nothing on screen says which.
 *
 *  `agingColorCls`, not `agingTextCls`: the latter adds `font-medium` at level
 *  6, which would collide with this value's `font-semibold` and resolve by
 *  stylesheet order rather than intent. At 1.15rem semibold the colour alone
 *  carries the alarm. */
export function PanelAgeStat({ project }: { project: AitoProject }) {
  const { t, i18n } = useTranslation();
  const { anchor, raw, at } = ageAnchor(project);

  return (
    <div data-testid="panel-age" className="text-right flex-shrink-0">
      <span data-testid="panel-age-anchor" className={`${eyebrowCls} block text-bambu-gray`}>
        {anchor === 'accepted' ? t('aito.ageAnchorAccepted') : t('aito.createdLabel')}
      </span>
      <span
        data-testid="panel-age-value"
        title={at ? at.toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : undefined}
        className={`flex items-center justify-end gap-1.5 text-[1.15rem] leading-tight font-semibold tracking-[-0.01em] tabular-nums ${agingColorCls(project, at)}`}
      >
        {/* strokeWidth 2.5 so the glyph's stems match the semibold digits
            beside it, same reason as the header's client icon. */}
        <Clock className="w-[.95rem] h-[.95rem] flex-shrink-0" strokeWidth={2.5} aria-hidden="true" />
        {formatElapsedTime(raw, t)}
      </span>
      {/* Dropped first when the header runs out of room: the relative value
          above is the point, the exact date is the corroboration. */}
      {at && (
        <span data-testid="panel-age-date" className="hidden lg:block text-xs text-bambu-gray tabular-nums">
          {at.toLocaleDateString(i18n.language, { dateStyle: 'medium' })}
        </span>
      )}
    </div>
  );
}
