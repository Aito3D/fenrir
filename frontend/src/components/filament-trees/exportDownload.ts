import { api } from '../../api/client';

/** "Export for slicer": fetch the generated leaves as a ZIP (all trees, one, or only the leaves changed since the last export) and save it. */
export async function downloadTreeExport(treeId?: number, changedOnly = false) {
  const { blob, token } = await api.exportFilamentTrees(treeId, changedOnly);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fenrir-filaments.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // deferred: WebKit can abort a download whose blob URL is revoked on the same tick
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  // the file is saved: only now do its leaves stop counting as pending (a failure here surfaces as the caller's error toast)
  // no token header: the download is still good, but there is nothing to confirm (leaves stay pending)
  if (token) await api.confirmFilamentTreeExport(token);
}
