import { lazy, Suspense, type ComponentProps } from 'react';
import { Loader2 } from 'lucide-react';

// Loaded on first open: the details modal sits beside the part viewer on the
// Projects and File Manager pages and is not needed to paint either list.
const Inner = lazy(() => import('./LibraryFileDetailsModal').then((m) => ({ default: m.LibraryFileDetailsModal })));

type Props = ComponentProps<typeof import('./LibraryFileDetailsModal').LibraryFileDetailsModal>;

/** Same name and props as the real modal; call sites only change the import path. */
export function LibraryFileDetailsModal(props: Props) {
  return (
    <Suspense
      fallback={
        <div data-testid="viewer-loading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" aria-busy="true">
          <Loader2 className="w-7 h-7 text-bambu-green animate-spin" />
        </div>
      }
    >
      <Inner {...props} />
    </Suspense>
  );
}
