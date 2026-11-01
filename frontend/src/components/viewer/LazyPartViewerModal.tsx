import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import type { PartViewerModalProps } from './PartViewerModal';

// The viewer is three.js plus the mesh loaders and jszip: ~250 KB gzipped
// that no page needs until someone opens a part. It is imported here and only
// here, so rolldown emits it as its own chunk, fetched on the first open.
const Inner = lazy(() => import('./PartViewerModal').then((m) => ({ default: m.PartViewerModal })));

/** Full-screen shield while the chunk is in flight: the page underneath stays
 *  inert, so a second click cannot open a second viewer. */
function ViewerLoading() {
  return (
    <div
      data-testid="viewer-loading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 pointer-events-auto"
      aria-busy="true"
    >
      <Loader2 className="w-7 h-7 text-bambu-green animate-spin" />
    </div>
  );
}

/** Same name and props as the real modal; call sites only change the import path. */
export function PartViewerModal(props: PartViewerModalProps) {
  return (
    <Suspense fallback={<ViewerLoading />}>
      <Inner {...props} />
    </Suspense>
  );
}
