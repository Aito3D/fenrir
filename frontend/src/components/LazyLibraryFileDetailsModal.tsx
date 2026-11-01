import { Suspense, type ComponentProps } from 'react';
import { lazyPage } from '../utils/lazyPage';
import { Loader2 } from 'lucide-react';

// Loaded on first open: the details modal sits beside the part viewer on the
// Projects and File Manager pages and is not needed to paint either list.
// lazyPage, not lazy: reloads once if a redeploy deleted the chunk (#3175).
const Inner = lazyPage(() => import('./LibraryFileDetailsModal'), 'LibraryFileDetailsModal');

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
