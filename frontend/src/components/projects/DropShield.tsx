import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { stopDrag } from './dialogStyles';

/** Portals `children` to `document.body` inside a `<div>` that stops React
 *  dragover/drop events: portalled dialogs still bubble them to the drop zone
 *  they were opened from, so a stray drag over a dialog would upload files. */
export function DropShield({ children }: { children: ReactNode }) {
  return createPortal(
    <div onDragOver={stopDrag} onDrop={stopDrag}>
      {children}
    </div>,
    document.body,
  );
}
