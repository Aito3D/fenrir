import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, Loader2 } from 'lucide-react';
import { api, type AitoProject, type AitoUnlinkedRetainer } from '../../../api/client';
import { ConfirmModal } from '../../ConfirmModal';
import { useToast } from '../../../contexts/ToastContext';
import { formatMoney } from '../../../utils/pricing';
import { settleProject } from '../settleProject';

/** Paid deposits of the customer's that name no quote (raised by hand in
 *  Books) or another quote than this one: they show in "Deposit available" but never reduce this quote's
 *  deposit due. Lists them with a button that links one to this quote.
 *  The caller mounts it only while a deposit is due and the customer has
 *  credit, so the live Books read is not made on every panel. */
export function UnlinkedRetainers({ project, canUpdate, currency }: {
  project: AitoProject;
  canUpdate: boolean;
  currency: string;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  // A deposit that names another quote is taken from it: asked first.
  const [asking, setAsking] = useState<AitoUnlinkedRetainer | null>(null);
  const { data } = useQuery({
    queryKey: ['aito-unlinked-retainers', project.id],
    queryFn: () => api.getAitoUnlinkedRetainers(project.id),
    staleTime: 60_000,
  });
  const link = useMutation({
    mutationFn: (retainerId: string) => api.linkAitoRetainer(project.id, retainerId),
    onSuccess: (row) => {
      settleProject(queryClient, project.id, row);
      for (const key of ['aito-unlinked-retainers', 'aito-retainers']) {
        queryClient.invalidateQueries({ queryKey: [key, project.id] });
      }
      showToast(t('aito.unlinkedRetainer.linked', { quote: project.quote_number }), 'success');
    },
    onError: (e: unknown) => showToast(e instanceof Error && e.message ? e.message : t('common.errorLoading'), 'error'),
  });

  if (!data?.length) return null;
  return (
    <div data-testid="unlinked-retainers" className="mt-2 space-y-1.5 text-sm">
      {data.map((retainer) => (
        <div key={retainer.id} className="rounded border border-status-warning/30 px-2 py-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-status-warning min-w-0">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{retainer.number}</span>
            </span>
            <span className="text-white">{formatMoney(retainer.unused, currency)}</span>
          </div>
          <p className="mt-0.5 text-xs text-bambu-gray">{retainer.linked_to ? t('aito.unlinkedRetainer.hintOther', { quote: retainer.linked_to }) : t('aito.unlinkedRetainer.hint')}</p>
          {canUpdate && (
            <button
              type="button"
              onClick={() => (retainer.linked_to ? setAsking(retainer) : link.mutate(retainer.id))}
              disabled={link.isPending}
              className="mt-1 inline-flex items-center gap-1.5 text-xs text-bambu-green hover:underline disabled:opacity-50"
            >
              {link.isPending && link.variables === retainer.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              {t('aito.unlinkedRetainer.link', { quote: project.quote_number })}
            </button>
          )}
        </div>
      ))}
      {asking && (
        <ConfirmModal
          title={t('aito.unlinkedRetainer.confirmTitle')}
          message={t('aito.unlinkedRetainer.confirmBody', { number: asking.number, from: asking.linked_to, quote: project.quote_number })}
          confirmText={t('aito.unlinkedRetainer.link', { quote: project.quote_number })}
          variant="warning"
          // Asked over the detail panel, which closes on Escape too.
          isolateEscape
          onConfirm={() => {
            link.mutate(asking.id);
            setAsking(null);
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}
