import { ChevronDown, ChevronRight } from 'lucide-react';
import { focusRingCls } from '../../formStyles';

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
      className={`flex min-h-[44px] w-full items-center gap-1.5 rounded-lg text-left md:min-h-0 ${focusRingCls}`}>
      {open ? <ChevronDown className="h-4 w-4 shrink-0 text-bambu-gray" /> : <ChevronRight className="h-4 w-4 shrink-0 text-bambu-gray" />}
      <span>{label}</span>{' '}
      <span className="text-xs font-normal text-bambu-gray">{count}</span>
    </button>
  );
}
