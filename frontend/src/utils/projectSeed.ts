import { DEFAULT_COUNTRY_CODE, isSocialNetwork, parsePhone } from './clientDraft';
import type { ClientDraft } from './clientDraft';
import { freshenTaskDraft, isBlankTaskDraft, emptyTaskDraft } from './taskDraft';
import type { TaskDraft } from './taskDraft';
import { splitRecipientName } from './shippingDraft';
import type { ShippingDraft } from './shippingDraft';
import type { PersistedDraft } from '../hooks/useNewProjectDraft';
import type { AitoProject, AitoShippingService } from '../api/client';

/** Everything a duplicate carries over from the card it was made from.
 *
 *  Deliberately the drawer's OWN persisted shape rather than a bespoke one:
 *  the duplicate opens the ordinary new-project drawer with an ordinary
 *  restored draft, so there is exactly one restore path to keep correct (see
 *  `writeNewProjectDraft`). Anything absent from `PersistedDraft` — the quote,
 *  the flag, the due date, the contacted mark, the tracking token, the
 *  invoice, the LTA — is, by construction, not copied: a duplicate is a NEW
 *  job for the same client, and every one of those facts belongs to the old
 *  one. */
export interface ProjectSeedInput {
  project: AitoProject;
  /** The card's tasks, already converted (`taskDraftFromAitoTask`). Passed in
   *  rather than fetched here so this stays a pure function the caller can
   *  drive from whatever cache already holds them. */
  tasks: TaskDraft[];
  /** The shipping catalogue, for re-reading TODAY's rate. Empty when Books
   *  has never resolved — the price then starts null and the drawer asks for
   *  one, exactly as it does for a fresh shipment. */
  services: AitoShippingService[];
  /** Zoho's walk-in contact id, so a duplicate of a walk-in card seeds a
   *  contact the drawer recognises as the default (it offers no "reset to
   *  walk-in" control for one, and the create rules treat it apart). */
  defaultContactId: string;
}

/** The client block as an UNTOUCHED contact: `original` mirrors what is being
 *  seeded and `touched` is all false, so creating the duplicate without
 *  editing the contact writes nothing back to Zoho — the same contract
 *  `draftFromContact` gives a freshly-picked contact. `phoneField` is
 *  'mobile' because that is the field the card's own phone came from
 *  (`draftFromContact` prefers it) and the one a rewrite would target. */
function clientFromProject(project: AitoProject, defaultContactId: string): ClientDraft | null {
  // A legacy clientless card has nothing to seed. The drawer then opens on
  // its own default-contact effect, which is the right starting point.
  if (!project.client_id || !project.client_name) return null;
  const phone = project.client_phone ?? '';
  const { countryCode, nationalNumber } = parsePhone(phone);
  const email = project.client_email ?? '';
  const network = isSocialNetwork(project.client_social_network) ? project.client_social_network : null;
  return {
    id: project.client_id,
    name: project.client_name,
    isDefault: project.client_id === defaultContactId,
    isCompany: project.client_is_company ?? false,
    countryCode,
    nationalNumber,
    email,
    socialNetwork: network,
    // The handle only exists alongside a network, the same pairing rule the
    // server enforces and `normaliseClientDraft` repairs.
    socialHandle: network ? (project.client_social_handle ?? '') : '',
    touched: { phone: false, email: false },
    blurred: { phone: false, email: false },
    original: { phone, email, phoneField: 'mobile' },
  };
}

/** The shipment, with the price re-read from the catalogue instead of copied.
 *
 *  Copying the old price would quietly bill last year's rate on a new parcel;
 *  the recipient and destination, by contrast, are exactly what makes the
 *  duplicate worth having. `priceEdited` starts false for the same reason it
 *  does on a fresh shipment: there is no operator override to protect yet, so
 *  changing the island still re-seeds the rate. A catalogue that cannot
 *  answer leaves the price null, which the drawer already renders as "enter
 *  one". */
function shippingFromProject(project: AitoProject, services: AitoShippingService[]): ShippingDraft | null {
  if (project.shipping_island === null) return null;
  const service = project.shipping_service ?? '';
  const { countryCode, nationalNumber } = parsePhone(project.shipping_phone ?? '');
  const names =
    project.shipping_first_name || project.shipping_last_name
      ? { firstName: project.shipping_first_name ?? '', lastName: project.shipping_last_name ?? '' }
      : splitRecipientName(project.client_name ?? '');
  return {
    island: project.shipping_island,
    service,
    firstName: names.firstName,
    lastName: names.lastName,
    countryCode: countryCode || DEFAULT_COUNTRY_CODE,
    nationalNumber,
    price: services.find((s) => s.key === service)?.rate ?? null,
    priceEdited: false,
    blurred: { island: false, firstName: false, lastName: false, phone: false },
  };
}

/** A finished card turned back into a new-project draft — the "same thing
 *  again" a regular asks for.
 *
 *  The description rides along as an already-hand-edited summary
 *  (`summaryEdited: true`): the operator wrote it for this exact job, and
 *  letting the AI regenerate over it would throw away the one piece of the
 *  card that was written rather than computed. An empty `summarySignature`
 *  means the drawer still asks for a fresh summary the moment the operator
 *  changes the work — but only if they have not edited the text themselves,
 *  which the flag above says they have. */
export function seedFromProject({ project, tasks, services, defaultContactId }: ProjectSeedInput): PersistedDraft {
  const fresh = tasks.filter((task) => !isBlankTaskDraft(task)).map(freshenTaskDraft);
  return {
    // The drawer reads `tasks[0]` unguarded in places; a card whose tasks were
    // all blank still opens on the one empty row a new draft would have.
    tasks: fresh.length > 0 ? fresh : [emptyTaskDraft()],
    client: clientFromProject(project, defaultContactId),
    summaryText: project.description ?? '',
    summaryEdited: true,
    summarySignature: '',
    shipping: shippingFromProject(project, services),
    // Not copied: a promised date belongs to the job that promised it.
    dueDate: '',
    // Nothing has been prefilled from history yet — this is a fresh drawer
    // session, and the recall prefill should run normally for this client.
    socialPrefilledFor: [],
  };
}

/** True when the stored draft holds nothing the operator typed.
 *
 *  The question a duplicate has to answer before it overwrites: a blank draft
 *  is replaced silently, anything else is worth a confirmation. The walk-in
 *  contact alone does NOT count as content — the drawer seeds that itself on
 *  open, so treating it as work would make every reopened-and-abandoned
 *  drawer prompt forever. */
export function isBlankPersistedDraft(draft: PersistedDraft | null): boolean {
  if (draft === null) return true;
  if ((draft.tasks ?? []).some((task) => !isBlankTaskDraft(task))) return false;
  if ((draft.summaryText ?? '').trim() !== '') return false;
  if (draft.summaryEdited) return false;
  if ((draft.dueDate ?? '') !== '') return false;
  if (draft.shipping !== null && draft.shipping !== undefined) return false;
  // A contact the operator picked is content; the default walk-in one, which
  // the drawer fills in by itself, is not.
  return draft.client === null || draft.client.isDefault;
}
