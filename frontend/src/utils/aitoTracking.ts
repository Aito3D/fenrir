import type { AitoColumnId, AitoTracking } from '../api/client';

/** Fixed French copy for the public page — deliberately outside the i18n
 *  catalogues: the audience is the client in Tahiti, not the operator.
 *  Titles are SHORT: the client scans "En fabrication" faster than a
 *  sentence; the sub-line carries the human voice. */
export const FR = {
  title: 'Suivi de votre commande',
  brand: 'Aito3D',
  reference: (ref: string) => `Devis n° ${ref}`,
  stepOf: (n: number, total: number) => `Étape ${n} sur ${total}`,
  tasksHeading: 'Vos pièces',
  eta: 'Disponibilité estimée',
  updated: (when: string) => `Mis à jour ${when}`,
  loading: 'Chargement…',
  invalid: "Ce lien n'est plus valide.",
  footerLead: 'Une question sur votre commande ? Nous sommes disponibles au',
  footerOr: 'ou à',
  invoice: {
    paid: { title: 'Facture réglée', sub: 'Merci pour votre confiance.', terms: false },
    unpaid: { title: 'Facture à régler', sub: "À régler avant le retrait ou l'expédition.", terms: true },
    overdue: { title: 'Facture en retard', sub: 'Contactez-nous si vous avez déjà payé.', terms: true },
  },
  paymentTermsToggle: 'Voir les modalités',
  paymentTerms:
    'Règlement par virement ou au magasin, en indiquant le numéro de votre devis. Répondez à notre message pour toute question.',
  status: {
    devis: { title: 'Devis en préparation', sub: "Vous le recevrez par e-mail dès qu'il est prêt." },
    waiting: { title: 'En attente de votre accord', sub: 'Dites-nous si vous validez le devis, et nous lançons la fabrication.' },
    working: { title: 'En fabrication', sub: 'Nous préparons actuellement vos pièces.' },
    finish: { title: 'Votre commande est prête', sub: "Vous pouvez venir la récupérer au magasin ; répondez à notre message pour convenir d'un horaire." },
    shipped: (island: string, service: string) => ({ title: 'Expédiée', sub: `Vers ${island} par ${service}.` }),
    pickedUp: (date: string) => ({ title: 'Récupérée', sub: `Le ${date}. Merci pour votre confiance !` }),
    doneBare: { title: 'Terminée', sub: 'Merci pour votre confiance !' },
  },
} as const;

const STAGE_LABELS: Record<Exclude<AitoColumnId, 'done'>, string> = {
  devis: 'Devis',
  waiting: 'Accord',
  scan: 'Scan',
  model: 'Modélisation',
  print: 'Fabrication',
  finish: 'Prête',
};

/** The seven stages in board order. The LAST one is named by how this order
 *  ends — "Expédiée" for a shipment, "Récupérée" otherwise — because
 *  "Terminé" tells the client nothing they can picture. */
export function trackStages(shipped: boolean): { id: AitoColumnId; label: string }[] {
  return [
    ...(Object.keys(STAGE_LABELS) as Exclude<AitoColumnId, 'done'>[]).map((id) => ({ id, label: STAGE_LABELS[id] })),
    { id: 'done', label: shipped ? 'Expédiée' : 'Récupérée' },
  ];
}

const FR_LONG = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const FR_DAY_MONTH = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' });
const FR_TIME = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** A day (`2026-09-20`) or a naive UTC timestamp, as "20 septembre 2026".
 *  A bare day is pinned to noon so no timezone can roll it over. */
export function frLongDate(iso: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return FR_LONG.format(new Date(day ? `${iso}T12:00:00` : `${iso}Z`));
}

const sameLocalDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "aujourd'hui à 09:42" / "hier à 18:20" / "le 3 septembre à 11:05", in
 *  the browser's local time, from a naive UTC timestamp. */
export function frUpdated(isoUtc: string, now: Date = new Date()): string {
  const at = new Date(`${isoUtc}Z`);
  const time = FR_TIME.format(at);
  if (sameLocalDay(at, now)) return `aujourd'hui à ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(at, yesterday)) return `hier à ${time}`;
  return `le ${FR_DAY_MONTH.format(at)} à ${time}`;
}

export function statusCopy(data: AitoTracking): { title: string; sub: string } {
  switch (data.column) {
    case 'devis':
      return FR.status.devis;
    case 'waiting':
      return FR.status.waiting;
    case 'finish':
      return FR.status.finish;
    case 'done':
      if (data.shipping) return FR.status.shipped(data.shipping.island, data.shipping.service);
      if (data.done_at) return FR.status.pickedUp(frLongDate(data.done_at));
      return FR.status.doneBare;
    default:
      return FR.status.working;
  }
}
