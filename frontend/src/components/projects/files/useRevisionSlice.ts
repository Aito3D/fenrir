import type { ProjectRevisionOut } from '../../../api/client';
import { useSliceJobPercent } from '../../../hooks/useSliceJobPercent';

export type RevisionSliceState = 'none' | 'slicing' | 'sliced' | 'failed' | 'legacy-sliced';

/** A revision's server slice state for its card. `legacy-sliced`: a revision made before server
 *  slicing whose own file is already sliced (no `slice_status`, `print_profile.sliced`). While
 *  slicing, `percent` is the job's live total (null when the job is unknown: indeterminate).
 *  An item without a revision yet reads `none`. */
export function useRevisionSlice(revision: ProjectRevisionOut | undefined): {
  state: RevisionSliceState;
  percent: number | null;
  error: string | null;
} {
  const slicing = revision?.slice_status === 'slicing';
  const job = useSliceJobPercent(slicing ? revision?.slice_job_id : null);
  if (!revision) return { state: 'none', percent: null, error: null };
  if (slicing) {
    // The job failed before the tree caught up: show the failure now, the poll brings its error.
    if (job.failed) return { state: 'failed', percent: null, error: revision.slice_error };
    return { state: 'slicing', percent: job.percent, error: null };
  }
  if (revision.slice_status === 'sliced') return { state: 'sliced', percent: null, error: null };
  if (revision.slice_status === 'failed') return { state: 'failed', percent: null, error: revision.slice_error };
  const pp = revision.print_profile as { sliced?: unknown } | null;
  return { state: pp?.sliced ? 'legacy-sliced' : 'none', percent: null, error: null };
}
