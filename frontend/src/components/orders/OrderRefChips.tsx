import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OrderPanelRow } from '../../api/client';

const CHIP = 'inline-flex items-center gap-1.5 rounded-full border border-bambu-dark-tertiary bg-bambu-dark-secondary px-2.5 py-1 text-xs text-bambu-gray';

/** One chip: a link in a new tab when it has an address, plain text otherwise. */
function Chip({ href, children }: { href?: string | null; children: ReactNode }) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${CHIP} hover:border-bambu-green/60 hover:text-white`}>
      {children}
      <ExternalLink aria-hidden="true" className="h-3 w-3 opacity-60" />
    </a>
  ) : (
    <span className={CHIP}>{children}</span>
  );
}

/** Where this order comes from: the order in Books, the Shopify order or the quote, then how it ships and is paid.
 *  `children` sits at the right end of the row (the order's actions: watch, cancel). */
export function OrderRefChips({ row, children }: { row: OrderPanelRow; children?: ReactNode }) {
  const { t } = useTranslation();
  const f = row.facts;
  // An order can carry both: a POS sale is a Shopify order and may have been quoted first.
  const quote = f.quote_number || (f.quote_url ? '' : null);
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      <Chip href={row.zoho_url}>Zoho Books · <span className="font-mono text-white">{row.number}</span></Chip>
      {(f.shopify_order || f.shopify_url) && (
        <Chip href={f.shopify_url}>Shopify{f.shopify_order && <> · <span className="font-mono text-white">#{f.shopify_order}</span></>}</Chip>
      )}
      {quote !== null && (
        <Chip href={f.quote_url}>{t('orders.chip.quote')}{quote && <> · <span className="font-mono text-white">{quote}</span></>}</Chip>
      )}
      {f.delivery_method && <Chip>{f.delivery_method}</Chip>}
      {f.payment_terms && <Chip>{f.payment_terms}</Chip>}
      {children && <span className="ml-auto flex items-center gap-1.5">{children}</span>}
    </div>
  );
}
