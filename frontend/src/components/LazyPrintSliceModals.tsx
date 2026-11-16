import { Suspense, type ComponentProps, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { lazyPage } from '../utils/lazyPage';

// Loaded on first open: neither modal is needed to paint the File Manager's
// list, and together they are a large share of what the page used to pull in.
// lazyPage, not lazy: reloads once if a redeploy deleted the chunk (#3175).
const PrintInner = lazyPage(() => import('./PrintModal'), 'PrintModal');
const SliceInner = lazyPage(() => import('./SliceModal'), 'SliceModal');

function Loading({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div data-testid="modal-loading" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" aria-busy="true">
          <Loader2 className="w-7 h-7 text-bambu-green animate-spin" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/** Same name and props as the real modal; call sites only change the import path. */
export function PrintModal(props: ComponentProps<typeof PrintInner>) {
  return (
    <Loading>
      <PrintInner {...props} />
    </Loading>
  );
}

/** Same name and props as the real modal; call sites only change the import path. */
export function SliceModal(props: ComponentProps<typeof SliceInner>) {
  return (
    <Loading>
      <SliceInner {...props} />
    </Loading>
  );
}
