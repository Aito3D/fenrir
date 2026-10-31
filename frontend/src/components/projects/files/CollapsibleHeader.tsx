import { ChevronRight } from 'lucide-react';
import { focusRingCls } from '../../formStyles';

/** The expand/collapse chevron of a files toggle button: one glyph that turns from right (closed)
 *  to down (open) — `.catalog-chevron`, the same 160ms turn as the catalog tree's folders. */
export function Chevron({ open }: { open: boolean }) {
  return <ChevronRight className="catalog-chevron h-4 w-4 shrink-0 text-bambu-gray" data-open={open} />;
}

interface Props {
  open: boolean;
  onToggle: () => void;
  label: string;
  count: number;
}

/** The chevron toggle of a collapsible files block: label, then its count. The
 *  caller wraps it in its own heading (the heading classes differ per block). */
export function CollapsibleHeader({ open, onToggle, label, count }: Props) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle}
      className={`btn-press flex min-h-[44px] w-full items-center gap-1.5 rounded-lg text-left md:min-h-0 ${focusRingCls}`}>
      <Chevron open={open} />
      <span>{label}</span>{' '}
      <span className="text-xs font-normal text-bambu-gray">{count}</span>
    </button>
  );
}
