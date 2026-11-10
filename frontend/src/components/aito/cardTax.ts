import { createContext } from 'react';

/** The open card's tax rate when it has its own (PUT /aito/{id}/tax), or null for the calculator's default
 *  `tax_pct`. The print calculator prices a tax-inclusive figure, so it has to use the card's rate. */
export const CardTaxContext = createContext<number | null>(null);
