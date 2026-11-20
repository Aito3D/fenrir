import type { OrderItemHit } from '../../api/client';
import { nameColour } from './itemSearchText';

/** The colour of a product, read from its name: a rounded square for a filament (the colour is what is being
 *  chosen), a small dot for anything else. Dashed when the name names no colour. */
export function ItemSwatch({ item }: { item: Pick<OrderItemHit, 'name' | 'filament'> }) {
  const colour = nameColour(item.name);
  return (
    <span
      aria-hidden="true"
      data-testid={item.filament ? 'swatch-filament' : 'swatch-dot'}
      className={`flex-shrink-0 border border-white/20 ${item.filament ? 'h-6 w-6 rounded-md' : 'h-2.5 w-2.5 rounded-full'}`}
      style={{ background: colour ?? 'transparent', borderStyle: colour ? 'solid' : 'dashed' }}
    />
  );
}
