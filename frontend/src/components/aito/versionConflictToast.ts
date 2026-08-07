import { ApiError } from '../../api/client';

/** The onError toast every `expected_version`-guarded board mutation shows:
 *  a version conflict gets its own message (the board moved under the
 *  operator, see `aito.editConflict`), anything else falls back to the
 *  generic save-failed one. Three call sites used to hand-copy this same
 *  three-line ternary (`ProjectDetailPanel`'s description and social
 *  mutations, `ShippingCard`'s shipping mutation) — one place to keep them
 *  from drifting on the code check or the fallback key. */
export function showVersionConflictToast(
  error: unknown,
  t: (key: string) => string,
  showToast: (message: string, type: 'error') => void,
): void {
  showToast(t(error instanceof ApiError && error.code === 'version_conflict' ? 'aito.editConflict' : 'aito.saveFailed'), 'error');
}
