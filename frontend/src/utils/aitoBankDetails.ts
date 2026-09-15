/** The shop's payment coordinates, as printed on the public tracking page.
 *
 *  A constant rather than a setting, for the same reason as `AITO3D_SENDER`
 *  in shippingLabel.ts: single-tenant deployment, changes about never, one
 *  place to edit, nothing that can be blank on a fresh install. Numbers are
 *  not translated — only the labels around them carry i18n keys. */
export const AITO3D_BANK = {
  beneficiary: "SARL O'SEA",
  bank: 'Socredo',
  iban: 'FR76 1746 9000 3120 6624 2000 041',
  bic: 'SOCBPFTXXXX',
  /** RIB: code banque · code guichet · numéro de compte · clé. */
  rib: ['17469', '00031', '20662420000', '41'],
} as const;

/** Peer-to-peer transfer apps the shop accepts, each with its beneficiary tag. */
export const AITO3D_TRANSFER_APPS = [
  { name: 'Deblock', tag: '@paul3482' },
  { name: 'Revolut', tag: '@paulteloe' },
] as const;
