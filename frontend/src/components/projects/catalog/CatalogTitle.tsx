import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { api } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { focusRingCls } from '../../formStyles';
import { AiTextField } from '../../aito/AiTextField';
import type { AiTextFieldHandle } from '../../aito/AiTextField';
import { useInvalidateProjects } from '../projectQueries';

/** The pane's project title: a click turns it into the AI text field the project page uses
 *  (French rewording on blur, with undo). Enter or the check commits — the field checks the
 *  text first when it has not been yet — Escape or the cross leaves it. Read-only without
 *  the update permission. */
export function CatalogTitle({ projectId, name }: { projectId: number; name: string }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const invalidateProjects = useInvalidateProjects();
  const [draft, setDraft] = useState<string | null>(null);
  const field = useRef<AiTextFieldHandle>(null);

  const save = useMutation({
    mutationFn: (next: string) => api.updateProject(projectId, { name: next }),
    onSuccess: () => {
      invalidateProjects(projectId);
      showToast(t('projectsPdm.saved'), 'success');
      setDraft(null);
    },
    onError: () => showToast(t('projectsPdm.saveFailed'), 'error'),
  });

  const commit = () => {
    const next = (draft ?? '').trim();
    if (!next || save.isPending) return;
    if (next === name) {
      setDraft(null);
      return;
    }
    save.mutate(next);
  };

  if (draft === null) {
    const heading = <h2 className="truncate text-lg font-semibold text-white">{name}</h2>;
    if (!hasPermission('projects:update')) return heading;
    return (
      <button type="button" onClick={() => setDraft(name)} title={t('projectsPdm.catalog.clickToRename')}
        className={`min-w-0 max-w-full rounded px-1 -mx-1 text-left hover:bg-white/5 ${focusRingCls}`}>
        {heading}
      </button>
    );
  }

  return (
    <div data-testid="catalog-title-editor" className="flex min-w-0 flex-1 items-center gap-1.5">
      <AiTextField
        ref={field}
        label={t('projectsPdm.titleLabel')}
        value={draft}
        onChange={setDraft}
        className="min-w-0 flex-1"
        settleInitial
        autoFocus
        correct={(text) => api.reformulateProjectText(text, 'title')}
        onSubmit={commit}
        onCancel={() => setDraft(null)}
      />
      {/* mousedown is swallowed so the click does not blur the field first: a blur would start
          its own check and the click would then save the text from before it. */}
      <button type="button" aria-label={t('projectsPdm.save')} title={t('projectsPdm.save')} disabled={!draft.trim() || save.isPending}
        onMouseDown={(e) => e.preventDefault()} onClick={() => field.current?.submit()}
        className={`rounded p-1 text-bambu-green hover:bg-white/5 disabled:opacity-40 ${focusRingCls}`}>
        <Check className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={() => setDraft(null)}
        className={`rounded p-1 text-bambu-gray hover:bg-white/5 hover:text-white ${focusRingCls}`}>
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
