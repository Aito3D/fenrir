import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { ProjectTreeResponse } from '../../../api/client';
import { Button } from '../../Button';
import { useToast } from '../../../contexts/ToastContext';
import { ENABLED_SECTIONS, SECTION_LABEL_KEYS, STATUS_LABEL_KEYS } from '../files/filesUi';
import { useInvalidateProjectLinks } from './useOrderProjectLinks';
import { useIsolatedEscape } from '../../../hooks/useIsolatedEscape';

/** Newest `valide` revision of every item in the enabled sections (Impression:
 *  projects hold printing files only for now) — the default delivery suggestion
 *  (spec §4.3). Returns, per item, the suggested revision id, so only those
 *  items' checks change. Items left in a disabled section stay listed and
 *  checkable, never suggested. */
function suggestLatestApproved(tree: ProjectTreeResponse): Map<number, number> {
  const picks = new Map<number, number>();
  for (const section of tree.sections) {
    if (!ENABLED_SECTIONS.includes(section.section)) continue;
    for (const item of section.items) {
      const best = item.revisions
        .filter((r) => r.status === 'valide')
        .reduce<{ id: number; number: number } | null>((acc, r) => (!acc || r.number > acc.number ? r : acc), null);
      if (best) picks.set(item.id, best.id);
    }
  }
  return picks;
}

/** Which of the linked project's revisions this task delivered: a checkbox per
 *  revision, grouped section → item, with the suggestion and "reuse the files
 *  of another order" shortcuts. Saving replaces the task's whole list. */
export function DeliveriesPicker({
  orderId,
  taskId,
  projectId,
  current,
  onClose,
}: {
  orderId: number;
  taskId: number;
  projectId: number;
  current: number[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const invalidate = useInvalidateProjectLinks();
  const [checked, setChecked] = useState(() => new Set(current));
  const dialogRef = useRef<HTMLDivElement>(null);
  useIsolatedEscape(onClose, dialogRef);

  const { data: tree } = useQuery({ queryKey: ['project-tree', projectId], queryFn: () => api.getProjectTree(projectId) });
  const { data: orders } = useQuery({
    queryKey: ['project-orders', projectId],
    queryFn: () => api.getProjectOrders(projectId),
    retry: false,
  });
  const reusable = (orders?.orders ?? []).filter((o) => o.task_id !== taskId && o.deliveries.length > 0);

  const save = useMutation({
    mutationFn: () => {
      // Tree order, so the stored list reads the way the picker did.
      const ids = (tree?.sections ?? []).flatMap((s) =>
        s.items.flatMap((i) => i.revisions.filter((r) => checked.has(r.id)).map((r) => r.id)),
      );
      return api.setTaskDeliveries(taskId, ids);
    },
    onSuccess: () => {
      invalidate(orderId, [projectId]);
      onClose();
    },
    onError: () => showToast(t('projectsPdm.files.saveFailed'), 'error'),
  });

  const toggle = (id: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const suggest = () => {
    if (!tree) return;
    const picks = suggestLatestApproved(tree);
    setChecked((prev) => {
      const next = new Set(prev);
      for (const section of tree.sections) {
        for (const item of section.items) {
          const pick = picks.get(item.id);
          if (pick === undefined) continue;
          item.revisions.forEach((r) => next.delete(r.id));
          next.add(pick);
        }
      }
      return next;
    });
  };

  const sections = (tree?.sections ?? []).filter((s) => s.items.some((i) => i.revisions.length > 0));

  // Portalled: the panel's task row is a file drop target and must not see
  // drops (or stacking) from this modal.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={t('projectsPdm.aito.deliveredFiles')}
        className="flex max-h-[85vh] w-full max-w-md flex-col gap-3 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-5 focus:outline-none"
      >
        <h2 className="text-lg font-semibold text-white">{t('projectsPdm.aito.deliveredFiles')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={suggest} disabled={!tree}>
            {t('projectsPdm.aito.deliveriesSuggest')}
          </Button>
          {reusable.length > 0 && (
            <select
              value=""
              aria-label={t('projectsPdm.aito.reuseFromOrderPlaceholder')}
              onChange={(e) => {
                const order = reusable.find((o) => String(o.task_id) === e.target.value);
                if (order) setChecked(new Set(order.deliveries.map((d) => d.id)));
              }}
              className="min-w-0 flex-1 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1.5 text-sm text-white"
            >
              <option value="" disabled>
                {t('projectsPdm.aito.reuseFromOrderPlaceholder')}
              </option>
              {reusable.map((o) => (
                <option key={o.task_id} value={o.task_id}>
                  {t('projectsPdm.aito.reuseFromOrder', { order: o.order_id })}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {tree && sections.length === 0 && (
            <p className="text-sm text-bambu-gray">{t('projectsPdm.files.emptySection')}</p>
          )}
          {sections.map((s) => (
            <section key={s.section} className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-bambu-gray">
                {t(SECTION_LABEL_KEYS[s.section])}
              </h3>
              {s.items
                .filter((i) => i.revisions.length > 0)
                .map((item) => (
                  <div key={item.id} className="space-y-0.5 pl-1">
                    <p className="text-sm text-white">{item.name}</p>
                    {item.revisions.map((r) => (
                      <label key={r.id} className="flex items-center gap-2 pl-2 text-sm text-bambu-gray-light">
                        <input
                          type="checkbox"
                          checked={checked.has(r.id)}
                          onChange={() => toggle(r.id)}
                          aria-label={`${item.name} R${r.number} · ${t(STATUS_LABEL_KEYS[r.status])}`}
                          className="accent-bambu-green"
                        />
                        <span aria-hidden="true" className="tabular-nums">{`R${r.number}`}</span>
                        <span aria-hidden="true" className="text-xs text-bambu-gray">
                          {t(STATUS_LABEL_KEYS[r.status])}
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
            </section>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={() => save.mutate()} disabled={!tree || save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
