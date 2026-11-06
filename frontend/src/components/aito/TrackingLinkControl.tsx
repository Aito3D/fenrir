import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { copyTextToClipboard, writeClipboardFromPromise } from '../../utils/clipboard';
import { LINK_ICON_BUTTON_CLS, LINK_ICON_CLS, openFetchedLink, useCopiedFlash } from './linkActionHelpers';
import { CopiedLabel } from './linkActions';

/** Open / Copy for the card's public tracking link, in the
 *  panel's Record card, under the provenance rows it belongs with. Same
 *  vocabulary as the Billing card's payment-link row (`linkActions.tsx`).
 *
 *  Open and Copy both go through the link endpoint rather than reading a URL
 *  off the board cache — the board response carries none, and the first call
 *  is also what mints the token for a card that has never had one. Open
 *  therefore opens the tab BEFORE the request (see `openFetchedLink`), so
 *  the browser still attributes it to the click. There is deliberately no
 *  regenerate: a card keeps one link for its whole life, so the code printed
 *  on its quote and labels always works.
 *
 *  Both are disabled — with a pointer at Settings — until `external_url`
 *  is set: `tracking_configured` mirrors that (see `AitoProject.tracking_configured`
 *  / `_to_response` in `routes/aito.py`), and there is no useful link to open
 *  or copy without it. */
export function TrackingLinkControl({ project }: { project: AitoProject }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [copied, flashCopied] = useCopiedFlash();
  const configured = project.tracking_configured;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['aito-projects'] });

  const copy = useMutation({
    mutationFn: async ({ link, write }: { link: Promise<string | null>; write: Promise<void> | null }) => {
      const written = write ? await write.then(() => true, () => false) : false;
      return { tracking_url: await link, written, attempted: write !== null };
    },
    onSuccess: async ({ tracking_url, written, attempted }) => {
      // Both failure paths toast rather than dying quietly (T-090): an empty
      // `tracking_url` means the endpoint minted nothing,
      // and a failed copy means the browser refused the write. PaymentBlock's
      // link_pending copy button already toasts on refusal, so this also keeps
      // the two link rows behaving alike.
      if (!tracking_url) {
        showToast(t('common.errorLoading'), 'error');
        return;
      }
      // `written`: the in-gesture ClipboardItem write already landed; otherwise
      // fall back to the post-fetch write (plain-HTTP origins, refused writes).
      if (written || (await copyTextToClipboard(tracking_url))) {
        flashCopied();
      } else {
        showToast(attempted ? t('aito.trackingCopyFailed') : t('common.errorLoading'), 'error');
      }
      invalidate();
    },
    onError: () => showToast(t('common.errorLoading'), 'error'),
  });

  // The clipboard write starts here, synchronously in the click, not in the
  // mutation: the link fetch outlives the user gesture (T-041).
  const startCopy = () => {
    const link = api.getAitoTrackingLink(project.id).then((r) => r.tracking_url);
    const write = writeClipboardFromPromise(link);
    write?.catch(() => undefined);
    copy.mutate({ link, write });
  };

  const open = useMutation({
    mutationFn: () =>
      openFetchedLink(async () => {
        const { tracking_url } = await api.getAitoTrackingLink(project.id);
        return tracking_url;
      }),
    onSuccess: invalidate,
    onError: () => showToast(t('common.errorLoading'), 'error'),
  });


  const disabledTitle = configured ? undefined : t('aito.trackingNeedsExternalUrl');

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
          onClick={startCopy}
          className={LINK_ICON_BUTTON_CLS}
        >
          {copied ? (
            <Check className={`${LINK_ICON_CLS} text-bambu-green animate-tick-in`} aria-hidden="true" />
          ) : (
            <Copy className={LINK_ICON_CLS} aria-hidden="true" />
          )}
        </button>
      </span>
      {!configured && (
        <Link to="/settings?tab=network" className="text-xs text-bambu-green hover:underline">
          {t('aito.trackingSettingsLink')}
        </Link>
      )}
    </span>
  );
}
