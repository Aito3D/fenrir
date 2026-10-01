import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, type AitoProject } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import type { TaskDraft } from '../../utils/taskDraft';
import { buildSummary, copyText } from './copySummary';
import { buildJobTicketHtml } from './printJobTicket';
import { usePrintBlob } from './usePrintBlob';

/** The card menu's two read-only exports — Copy summary and Print job ticket
 *  (spec A4, A6) — kept out of the panel, which only hands over the card and
 *  its live task list.
 *
 *  Both want the tracking URL, which no query keeps warm: the endpoint MINTS
 *  the token on first call, so it is an update (`AITO_UPDATE` server-side) and
 *  is fetched only when a row is chosen — the menu itself costs nothing. The
 *  answer is cached under `['aito-tracking-link', id]` so a second copy needs
 *  no round trip (the clipboard wants the write close to the click); a
 *  regenerate drops that entry (TrackingLinkControl). A card whose shop has no
 *  `external_url`, or a viewer who may not edit, goes without the link rather
 *  than asking for one the server would refuse; a failed fetch does too —
 *  the rest of the text is still worth having. */
export function useCardActions(project: AitoProject, tasks: TaskDraft[], currency: string, canUpdate: boolean) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { print } = usePrintBlob({
    failureMessage: t('aito.jobTicketPrintFailed'),
    downloadFilename: `fiche-${project.id}.html`,
  });

  const trackingUrl = async (): Promise<string | null> => {
    if (!project.tracking_configured || !canUpdate) return null;
    try {
      const link = await queryClient.fetchQuery({
        queryKey: ['aito-tracking-link', project.id],
        queryFn: () => api.getAitoTrackingLink(project.id),
        staleTime: 5 * 60_000,
      });
      return link.tracking_url;
    } catch {
      return null;
    }
  };

  const copySummary = async () => {
    const text = buildSummary(project, tasks, currency, await trackingUrl(), t);
    if (await copyText(text)) showToast(t('aito.summaryCopied'), 'success');
    else showToast(t('aito.summaryCopyFailed'), 'error');
  };

  const printTicket = () =>
    print(async () => {
      // Same keys as ImpressionFields, which every task row mounts — so
      // these are normally already in the cache and cost nothing.
      const [url, printers, filaments] = await Promise.all([
        trackingUrl(),
        queryClient.ensureQueryData({ queryKey: ['calculatorPrinters'], queryFn: api.getCalculatorPrinters }),
        queryClient.ensureQueryData({ queryKey: ['calculatorFilaments'], queryFn: api.getCalculatorFilaments }),
      ]);
      const html = buildJobTicketHtml({
        project,
        tasks,
        printers,
        filaments,
        trackingUrl: url,
        printedBy: user?.username ?? '',
        now: new Date(),
      });
      return new Blob([html], { type: 'text/html' });
    });

  return { copySummary, printTicket };
}
