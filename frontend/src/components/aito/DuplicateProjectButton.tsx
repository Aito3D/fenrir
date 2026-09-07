import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Copy, Loader2 } from 'lucide-react';
import { ConfirmModal } from '../ConfirmModal';
import { readNewProjectDraft, writeNewProjectDraft } from '../../hooks/useNewProjectDraft';
import { isBlankPersistedDraft, seedFromProject } from '../../utils/projectSeed';
import { taskDraftFromAitoTask } from '../../utils/taskDraft';
import { api, type AitoProject } from '../../api/client';
import { focusRingCls } from '../formStyles';

/** "Same thing again" for a returning client.
 *
 *  A duplicate does not touch the card it was made from and posts nothing on
 *  its own: it fills the ordinary new-project drawer and hands the operator
 *  the wheel, so the quote is still reviewed, priced against today's rates and
 *  created by the same guarded path as any other. That is also why the seed
 *  travels through the drawer's OWN storage (`writeNewProjectDraft`) rather
 *  than a prop — one restore path, already hardened, instead of two.
 *
 *  Available on every card, not only a finished one: a client who calls back
 *  mid-job ("make me a second one") is the same request, and the board has no
 *  column where that stops being true.
 */
export function DuplicateProjectButton({
  project,
  onDuplicate,
}: {
  project: AitoProject;
  /** Fired once the seed is in storage. The page closes this panel and opens
   *  the drawer, which then reads the seed on mount. */
  onDuplicate: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  // Set when the operator asked while the tasks were still loading: the seed
  // then runs the moment they land, instead of copying a task-less card. A
  // ref, not state, because the effect below must read the CURRENT intent
  // and clearing it must not itself trigger another render pass.
  const pendingRef = useRef(false);
  const [waiting, setWaiting] = useState(false);

  // Same key the panel's own `useProjectTasks` uses, so this shares its cache
  // rather than issuing a second request for a list already on screen.
  const tasksQuery = useQuery({
    queryKey: ['aito-tasks', project.id],
    queryFn: () => api.getAitoTasks(project.id),
  });
  // Both are cached elsewhere in the panel/drawer (identical keys), so neither
  // costs a request in practice. The catalogue re-prices the shipment; the
  // status names the walk-in contact.
  const servicesQuery = useQuery({
    queryKey: ['aito-shipping-services'],
    queryFn: api.getAitoShippingServices,
    staleTime: 60 * 60_000,
  });
  const statusQuery = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 60_000,
  });

  const seed = () => {
    writeNewProjectDraft(
      seedFromProject({
        project,
        tasks: (tasksQuery.data ?? []).map(taskDraftFromAitoTask),
        services: servicesQuery.data?.services ?? [],
        defaultContactId: statusQuery.data?.default_contact_id ?? '',
      }),
    );
    onDuplicate();
  };

  // "The list is settled", NOT `isLoading`: React Query reports `isLoading`
  // false in the beat between a query mounting and its fetch actually
  // starting, so gating on it let a click land while `data` was still
  // undefined and silently seeded a task-less duplicate. Presence of data —
  // or a failure, which is as settled as it gets — is the honest test.
  const tasksSettled = tasksQuery.data !== undefined || tasksQuery.isError;

  // The deferred half of `start()`: the tasks arrived (or failed) after the
  // click. A failure still proceeds — with no tasks the drawer opens on the
  // client and description alone, which beats swallowing the gesture.
  useEffect(() => {
    if (!pendingRef.current || !tasksSettled) return;
    pendingRef.current = false;
    setWaiting(false);
    seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksSettled]);

  const start = () => {
    if (!tasksSettled) {
      pendingRef.current = true;
      setWaiting(true);
      return;
    }
    seed();
  };

  const click = () => {
    // A draft nobody typed into is replaced in silence; anything else is the
    // operator's unfinished work and gets a say.
    if (isBlankPersistedDraft(readNewProjectDraft())) {
      start();
      return;
    }
    setConfirming(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={click}
        disabled={waiting}
        aria-label={t('aito.duplicateProject')}
        title={t('aito.duplicateProject')}
        className={`inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-bambu-gray transition-colors hover:text-white disabled:opacity-50 ${focusRingCls}`}
      >
        {waiting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
        {t('aito.duplicateProject')}
      </button>
      {confirming && (
        <ConfirmModal
          title={t('aito.duplicateReplaceTitle')}
          message={t('aito.duplicateReplaceBody')}
          confirmText={t('aito.duplicateReplaceConfirm')}
          variant="warning"
          onConfirm={() => {
            setConfirming(false);
            start();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
