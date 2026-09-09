import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, Link2, RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { HoldButton } from './HoldButton';
import { useToast } from '../../contexts/ToastContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import { focusRingCls } from '../formStyles';

const ICON_BUTTON_CLS = `p-2 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-bambu-gray ${focusRingCls}`;

/** Copy / Regenerate for the card's public tracking link, in the panel's
 *  Record card, under the provenance rows it belongs with.
 *
 *  Copy goes through the link endpoint rather than reading `project.tracking_url`
 *  straight from the board cache — the first call is also what mints the
 *  token for a card that has never had one. Regenerate is a hold, like
 *  delete, because it kills the link the client may already have in hand:
 *  a stray click should not silently break a link someone printed on a
 *  shipping label.
 *
 *  Both are disabled — with a pointer at Settings — until `external_url` is
 *  set: `tracking_configured` mirrors that (see `AitoProject.tracking_configured`
 *  / `_to_response` in `routes/aito.py`), and there is no useful link to copy
 *  or regenerate without it. */
export function TrackingLinkControl({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const configured = project.tracking_configured;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['aito-projects'] });

  const copy = useMutation({
    mutationFn: () => api.getAitoTrackingLink(project.id),
    onSuccess: async ({ tracking_url }) => {
      if (!tracking_url) return;
      if (await copyTextToClipboard(tracking_url)) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
      invalidate();
    },
    onError: () => showToast(t('common.errorLoading'), 'error'),
  });

  const regenerate = useMutation({
    mutationFn: () => api.regenerateAitoTrackingToken(project.id),
    onSuccess: (data) => {
      showToast(t('aito.trackingRegenerated'), 'success');
      // The old link is on the quote too; the server rewrites the notes
      // as part of the regenerate. When Books was unreachable the local
      // link still changed, so say so — the next sync fixes the quote.
      if (data.quote_notes === 'failed') showToast(t('aito.trackingQuoteNotUpdated'), 'error');
      invalidate();
    },
    onError: () => showToast(t('common.errorLoading'), 'error'),
  });

  // Reuses the generic hold hint everywhere else in the panel (FlagControl,
  // ContactedControl, the delete button) rather than repeating the button's
  // own label back as its hint. Only the disabled case needs a bespoke
  // string, since that hint is the one place a reader would otherwise have
  // no idea why the button won't respond.
  const hint = configured ? t('aito.holdToConfirm') : t('aito.trackingNeedsExternalUrl');

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={!configured || copy.isPending}
        title={!configured ? t('aito.trackingNeedsExternalUrl') : copied ? t('aito.trackingCopied') : t('aito.trackingCopy')}
        aria-label={t('aito.trackingCopy')}
        onClick={() => copy.mutate()}
        className={ICON_BUTTON_CLS}
      >
        {copied ? <Check className="w-4 h-4 text-bambu-green" /> : <Link2 className="w-4 h-4" />}
      </button>
      {copied && <span className="text-xs text-bambu-green">{t('aito.trackingCopied')}</span>}
      <HoldButton
        onHold={() => regenerate.mutate()}
        durationMs={500}
        label={t('aito.trackingRegenerate')}
        hint={hint}
        disabled={!configured || regenerate.isPending}
        progress="ring"
        className={ICON_BUTTON_CLS}
      >
        <RotateCcw className="w-4 h-4" />
      </HoldButton>
      {!configured && (
        <Link to="/settings?tab=network" className="text-xs text-bambu-green hover:underline">
          {t('aito.trackingSettingsLink')}
        </Link>
      )}
    </span>
  );
}
