import { CheckCheck, ClipboardList, Package, ReceiptText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OrderBoardLine } from '../../api/client';
import type { PanelGroup } from './orderBoard';
import { TONE } from './orderStatus';
import type { Tone } from './orderStatus';

export const GROUP: Record<PanelGroup['id'], { label: string; icon: LucideIcon; tone: Tone; band: string; name: string; dim: boolean }> = {
  todo: { label: 'orders.group.todo', icon: ClipboardList, tone: 'neutral', band: 'bg-bambu-green/10', name: 'text-white', dim: false },
  packed: { label: 'orders.group.packed', icon: Package, tone: 'info', band: TONE.info.soft, name: TONE.info.text, dim: false },
  shipped: { label: 'orders.group.shipped', icon: CheckCheck, tone: 'neutral', band: TONE.neutral.soft, name: 'text-bambu-gray', dim: true },
  other: { label: 'orders.group.other', icon: ReceiptText, tone: 'neutral', band: TONE.neutral.soft, name: 'text-bambu-gray', dim: true },
};

export const LINE_STATE: Record<OrderBoardLine['state'], { label: string; cls: string }> = {
  ready: { label: 'orders.line.ready', cls: TONE.success.text },
  backorder: { label: 'orders.line.backorder', cls: TONE.warning.text },
  to_order: { label: 'orders.line.toOrder', cls: TONE.danger.text },
  shipped: { label: 'orders.line.shipped', cls: 'text-bambu-gray' },
  cancelled: { label: 'orders.line.cancelled', cls: 'text-bambu-gray' },
  service: { label: 'orders.line.service', cls: 'text-bambu-gray' },
};

export const dash = <span className="text-bambu-gray">–</span>;
export const EDIT_BTN = 'btn-press inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2.5 py-1 text-xs text-white hover:border-bambu-green hover:text-bambu-green disabled:opacity-50';
export const TRASH = 'grid h-7 w-7 place-items-center rounded-md text-bambu-gray hover:bg-red-500/15 hover:text-red-400 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-bambu-gray';
