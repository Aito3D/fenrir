import { api } from '../../api/client';

/** "Export for Orca": fetch the generated leaves as a ZIP (all trees, or one) and save it. */
export async function downloadTreeExport(treeId?: number) {
  const blob = await api.exportFilamentTrees(treeId);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'fenrir-filaments.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
