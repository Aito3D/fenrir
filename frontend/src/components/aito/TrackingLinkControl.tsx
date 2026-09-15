import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink, RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { HoldButton } from './HoldButton';
import { useToast } from '../../contexts/ToastContext';
import { copyTextToClipboard } from '../../utils/clipboard';
import { LINK_ICON_BUTTON_CLS, LINK_ICON_CLS, openFetchedLink, useCopiedFlash } from './linkActionHelpers';
import { CopiedLabel } from './linkActions';

/** Open / Copy / Regenerate for the card's public tracking link, in the
 *  panel's Record card, under the provenance rows it belongs with. Same
 *  vocabulary as the Billing card's payment-link row (`linkActions.tsx`).
 *
 *  Open and Copy both go through the link endpoint rather than reading a URL
 *  off the board cache — the board response carries none, and the first call
 *  is also what mints the token for a card that has never had one. Open
 *  therefore opens the tab BEFORE the request (see `openFetchedLink`), so
 *  the browser still attributes it to the click. Regenerate is a hold, like
 *  delete, because it kills the link the client may already have in hand:
 *  a stray click should not silently break a link someone printed on a
 *  shipping label.
 *
 *  All three are disabled — with a pointer at Settings — until `external_url`
 *  is set: `tracking_configured` mirrors that (see `AitoProject.tracking_configured`
 *  / `_to_response` in `routes/aito.py`), and there is no useful link to open,
 *  copy or regenerate without it. */
export function TrackingLinkControl({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, flashCopied] = useCopiedFlash();
  const configured = project.tracking_configured;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['aito-projects'] });

  const copy = useMutation({
    mutationFn: () => api.getAitoTrackingLink(project.id),
    onSuccess: async ({ tracking_url }) => {
      // Both failure paths toast rather than dying quietly (T-090): an empty
      // `tracking_url` means the endpoint minted nothing,
      // and a false from `copyTextToClipboard` means the browser refused the
      // write. PaymentLinkRow's copy already toasts on refusal, so this also
      // keeps the two link rows behaving alike.
      if (!tracking_url) {
        showToast(t('common.errorLoading'), 'error');
        return;
      }
      if (await copyTextToClipboard(tracking_url)) {
        flashCopied();
      } else {
        showToast(t('common.errorLoading'), 'error');
      }
      invalidate();
    },
    onError: () => showToast(t('common.errorLoading'), 'error'),
  });

  const open = useMutation({
    mutationFn: () =>
      openFetchedLink(async () => {
        const { tracking_url } = await api.getAitoTrackingLink(project.id);
        return tracking_url;
      }),
    onSuccess: invalidate,
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
  const disabledTitle = !configured ? t('aito.trackingNeedsExternalUrl') : undefined;

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      {/* Left of the buttons, not after them, so it never pushes the group
          off the card's right edge; the payment row places its own there too. */}
      <CopiedLabel phase={copied} text={t('aito.trackingCopied')} testId="tracking-copied" />
      <span className="inline-flex items-center gap-0.5">
        <button
          type="button"
          disabled={!configured || open.isPending}
          title={disabledTitle ?? t('aito.trackingOpen')}
          aria-label={t('aito.trackingOpen')}
          onClick={() => open.mutate()}
          className={LINK_ICON_BUTTON_CLS}
        >
          <ExternalLink className={LINK_ICON_CLS} aria-hidden="true" />
        </button>
        <button
          type="button"
          disabled={!configured || copy.isPending}
          title={disabledTitle ?? (copied ? t('aito.trackingCopied') : t('aito.trackingCopy'))}
          aria-label={t('aito.trackingCopy')}
          onClick={() => copy.mutate()}
          className={LINK_ICON_BUTTON_CLS}
        >
          {copied ? (
            <Check className={`${LINK_ICON_CLS} text-bambu-green animate-tick-in`} aria-hidden="true" />
          ) : (
            <Copy className={LINK_ICON_CLS} aria-hidden="true" />
          )}
        </button>
        <HoldButton
          onHold={() => regenerate.mutate()}
          durationMs={500}
          label={t('aito.trackingRegenerate')}
          hint={hint}
          disabled={!configured || regenerate.isPending}
          progress="ring"
          className={LINK_ICON_BUTTON_CLS}
        >
          <RotateCcw className={LINK_ICON_CLS} aria-hidden="true" />
        </HoldButton>
      </span>
      {!configured && (
        <Link to="/settings?tab=network" className="text-xs text-bambu-green hover:underline">
          {t('aito.trackingSettingsLink')}
        </Link>
      )}
    </span>
  );
}
