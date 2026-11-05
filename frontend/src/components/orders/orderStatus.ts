// How each order status and tone looks. One place, so tiles, chips, badges and
// the progress bar cannot drift apart. Light and dark pairs as elsewhere in the app.
import { PackageCheck, PackageOpen, ShoppingCart, Truck } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OrderStatus } from '../../api/client';

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export const TONE: Record<Tone, { text: string; soft: string; bar: string; edge: string; rail: string }> = {
  success: { text: 'text-green-700 dark:text-green-400', soft: 'bg-green-50 dark:bg-green-500/10', bar: 'bg-green-500', edge: 'border-l-green-500', rail: 'border-green-500/60' },
  info: { text: 'text-blue-700 dark:text-blue-400', soft: 'bg-blue-50 dark:bg-blue-500/10', bar: 'bg-blue-500', edge: 'border-l-blue-500', rail: 'border-blue-500/60' },
  warning: { text: 'text-yellow-700 dark:text-yellow-400', soft: 'bg-yellow-50 dark:bg-yellow-400/10', bar: 'bg-yellow-500', edge: 'border-l-yellow-500', rail: 'border-yellow-500/60' },
  danger: { text: 'text-red-700 dark:text-red-400', soft: 'bg-red-100 dark:bg-red-500/20', bar: 'bg-red-500', edge: 'border-l-red-500', rail: 'border-red-500/60' },
  neutral: { text: 'text-bambu-gray', soft: 'bg-bambu-dark-tertiary/60', bar: 'bg-bambu-gray', edge: 'border-l-bambu-green', rail: 'border-bambu-gray/40' },
};

export const STATUSES: OrderStatus[] = ['to_ship', 'partial', 'incoming', 'to_order'];

export const STATUS_META: Record<OrderStatus, { tone: Tone; icon: LucideIcon; label: string; hint: string }> = {
  to_ship: { tone: 'success', icon: PackageCheck, label: 'orders.status.toShip', hint: 'orders.hint.toShip' },
  partial: { tone: 'info', icon: PackageOpen, label: 'orders.status.partial', hint: 'orders.hint.partial' },
  incoming: { tone: 'warning', icon: Truck, label: 'orders.status.incoming', hint: 'orders.hint.incoming' },
  to_order: { tone: 'danger', icon: ShoppingCart, label: 'orders.status.toOrder', hint: 'orders.hint.toOrder' },
};
