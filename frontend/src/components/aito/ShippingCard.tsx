import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Phone, Plane } from 'lucide-react';
import { ShippingFields } from './ShippingFields';
import { HoldButton } from './HoldButton';
import { CopyableValue } from './ProjectDetailPanel';
import { emptyShippingDraft, islandLabel, isShippingComplete, shippingPayload } from '../../utils/shippingDraft';
import type { ShippingDraft } from '../../utils/shippingDraft';
import { formatPhoneDisplay, parsePhone } from '../../utils/clientDraft';
import { applyShipping } from '../../utils/aitoOptimistic';
import { api, type AitoProject, type AitoProjectUpdate, type AitoShippingService } from '../../api/client';
import { Money } from '../calculator/shared';
import { focusRingCls } from '../formStyles';
import { useProjectPatchMutation } from './useProjectPatchMutation';

/** Every shipment field the project already carries, reshaped into the same
 *  draft `ShippingFields` drives in the create drawer.
 *
 *  `priceEdited` is NOT hardcoded false: it is seeded by comparing the
 *  stored price against the stored service's catalogue rate. Air freight is
 *  billed by weight, so a bespoke price is the EXPECTED case, not the
 *  exception — if this always started false, re-opening Edit and correcting
 *  the island WITHIN the same service (`ShippingFields.selectIsland` only
 *  reseeds the price when `priceEdited` is false) would silently snap a
 *  deliberate bespoke price back to the catalogue rate. When the catalogue
 *  has not resolved, or no longer knows the stored service, there is nothing
 *  to compare against, so this defaults to false rather than guessing. A
 *  price that already matches the catalogue rate also starts false — no
 *  operator override to protect, and the create-drawer contract (island
 *  change re-seeds the price unless hand-edited) still applies. `blurred`
 *  starts empty so re-opening an already-valid shipment shows no red on
 *  first paint; only a fresh edit that fails validation should light one up. */
function draftFromProject(project: AitoProject, services: AitoShippingService[]): ShippingDraft {
  const { countryCode, nationalNumber } = parsePhone(project.shipping_phone ?? '');
  const catalogueRate = services.find((s) => s.key === project.shipping_service)?.rate ?? null;
  return {
    island: project.shipping_island ?? '',
    service: project.shipping_service ?? '',
    firstName: project.shipping_first_name ?? '',
    lastName: project.shipping_last_name ?? '',
    countryCode,
    nationalNumber,
    price: project.shipping_price,
    priceEdited: catalogueRate !== null && project.shipping_price !== catalogueRate,
    blurred: { island: false, firstName: false, lastName: false, phone: false },
  };
}

/** Optional air freight, on the panel's left column.
 *
 *  `project.shipping_island !== null` IS "has a shipment" — the only test,
 *  here and on the server. A project without one renders no card at all, only
 *  a discreet add button: this panel omits every section with nothing to say
 *  (see the Quote card's own gating), and an empty "Shipping" heading on the
 *  95% of projects that never fly a parcel would be exactly that noise.
 *
 *  Add and Edit share one body: both swap in `ShippingFields`, the same
 *  four-field-plus-service block the create drawer uses, driven controlled
 *  from a local draft. Edit seeds that draft from the PROJECT's stored
 *  columns (`draftFromProject`) rather than a blank one — the whole point of
 *  editing is to change what is already there, not to retype it. */
export function ShippingCard({ project, currency }: { project: AitoProject; currency: string }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ShippingDraft | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  // This card is the LAST thing in the panel's left column, so a form that
  // opens here — or grows a row, once an island resolves to a service and its
  // rate line appears — puts its own Cancel/Save below the fold. The column
  // scrolls, but its scrollbar is hidden (`scrollbar-hide`), so nothing on
  // screen says so and the buttons simply read as cut off. `block: 'nearest'`
  // scrolls the least amount that brings the form's bottom edge back inside,
  // and does nothing at all when it is already fully visible.
  // (`?.` on the call: jsdom has no scrollIntoView — same guard
  // SearchableSelect's highlight-follow effect uses.)
  useEffect(() => {
    if (!editing) return;
    editorRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    // `blurred` as a whole, not `blurred.island`: `save()` flips all four flags
    // at once, which is what makes the error lines appear and the form taller —
    // but by then the island has almost always been picked already, so its flag
    // is ALREADY true and watching it would miss exactly the case it was meant
    // to catch. The object identity changes on every blur and on that failed
    // Save, and never on a keystroke (`ShippingFields` only re-spreads it in
    // its blur handlers), so this stays a handful of fires per session.
  }, [editing, draft?.service, draft?.blurred]);

  // Same query key the create drawer and ClientSection use, so this shares
  // their cache instead of re-fetching a table that rarely changes.
  const servicesQuery = useQuery({
    queryKey: ['aito-shipping-services'],
    queryFn: api.getAitoShippingServices,
    staleTime: 60 * 60_000,
  });

  // Same SHAPE as `ProjectDetailPanel`'s description-save mutation — one
  // `useProjectPatchMutation`, an optimistic transform mirroring the
  // server's own write (`applyShipping` here, `applyDescription` there), and
  // the PATCH response written back into the `['aito-projects']` cache in
  // `onSuccess` — but not a byte-for-byte copy: a shipping PATCH also runs
  // through `diff_fields` server-side and records a `project.updated` event
  // (plus a possible `sync.queued`), same as every other board write, so
  // this invalidates `['aito-events', project.id]` too. `RecordCard` and
  // `ActivityRail` render immediately ABOVE this card in the same panel;
  // skipping the invalidation would leave their timeline stale after every
  // add/edit/remove until something else happened to refetch it.
  const shippingMutation = useProjectPatchMutation(project, (previous, patch: AitoProjectUpdate) =>
    applyShipping(previous, project.id, patch),
  );

  // Seeded from the project's stored client, exactly as the create drawer
  // seeds itself from its live client draft (`ClientSection`): the recipient
  // is the client on the overwhelming majority of parcels, and retyping a name
  // and a number the panel header already carries — pinned above a column the
  // operator has usually scrolled — is the busywork the drawer stopped asking
  // for. `emptyShippingDraft` owns the rules — company contacts seed no name,
  // a blank phone falls back to the default dialling code — so the two
  // surfaces cannot drift on them.
  //
  // `?? false` reads a NULL `client_is_company` as a person, and that is a
  // choice, not an oversight: the column arrived by ALTER TABLE, so rows
  // predating it hold NULL, and seeding a company's name splits it into
  // "AITO 3D / SARL". Prefilling anyway is still the better default — the
  // recipient the operator sees rejoins to exactly the client name, and it is
  // sitting in an editable field in front of them before anything is saved,
  // whereas an empty field on a legacy project just reads as the feature
  // being broken.
  const openAdd = () => {
    const { countryCode, nationalNumber } = parsePhone(project.client_phone ?? '');
    setDraft(
      emptyShippingDraft({
        name: project.client_name ?? '',
        isCompany: project.client_is_company ?? false,
        countryCode,
        nationalNumber,
      }),
    );
    setEditing(true);
  };
  const openEdit = () => {
    setDraft(draftFromProject(project, servicesQuery.data?.services ?? []));
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setDraft(null);
  };
  const save = () => {
    if (!draft) return;
    if (!isShippingComplete(draft)) {
      // Same reveal-on-submit discipline as NewProjectDrawer's `create`: a
      // field never left must still be checked, and asking to save is what
      // makes it count as left.
      setDraft({ ...draft, blurred: { island: true, firstName: true, lastName: true, phone: true } });
      return;
    }
    shippingMutation.mutate(shippingPayload(draft), {
      onSuccess: () => {
        setEditing(false);
        setDraft(null);
      },
    });
  };
  const remove = () => {
    shippingMutation.mutate({ shipping_island: null });
  };

  if (project.shipping_island === null && !editing) {
    return (
      <button
        type="button"
        onClick={openAdd}
        className={`inline-flex items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-sky-400/75 transition-colors hover:text-sky-400 ${focusRingCls}`}
      >
        <Plane className="h-3.5 w-3.5" />
        {t('aito.shippingAdd')}
      </button>
    );
  }

  // Shared with the panel header's pill and the create drawer's own
  // rail/checklist — see `islandLabel`'s doc for why the degrade has to be
  // one computation shared by all three rather than three separate ones.
  const shippingIslandLabel =
    project.shipping_island !== null ? islandLabel(project.shipping_island, servicesQuery.data?.services ?? []) : null;
  const recipient = [project.shipping_first_name, project.shipping_last_name].filter(Boolean).join(' ');
  const serviceName = project.shipping_service_name ?? project.shipping_service;

  return (
    <div className="rounded-[.6rem] border border-sky-400/35 bg-sky-400/[0.04] p-3">
      <div className="mb-2.5 flex items-center gap-2">
        {/* Enlarged like the board glyph's own heading use, task-12-brief. */}
        <Plane className="h-[1.15rem] w-[1.15rem] text-sky-400" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-wider text-sky-400">{t('aito.shippingTitle')}</span>
        {!editing && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={openEdit}
              className={`rounded-md px-1.5 py-0.5 text-xs text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
            >
              {t('aito.shippingEdit')}
            </button>
            <HoldButton
              onHold={remove}
              durationMs={500}
              disabled={shippingMutation.isPending}
              label={t('aito.shippingRemove')}
              hint={t('aito.holdToConfirm')}
              progress="bar"
              barClassName="bg-red-400/25"
              className="rounded-md px-1.5 py-0.5 text-xs text-bambu-gray hover:bg-red-400/10 hover:text-red-400 data-[holding=true]:text-red-400"
            >
              {t('aito.shippingRemove')}
            </HoldButton>
          </div>
        )}
      </div>

      {editing && draft ? (
        // `scroll-mb-4` so the reveal above leaves the Save row a little air
        // above the panel footer instead of flush against it.
        <div ref={editorRef} className="scroll-mb-4">
          <ShippingFields
            value={draft}
            onChange={setDraft}
            services={servicesQuery.data?.services ?? []}
            catalogueResolved={servicesQuery.data?.catalogue_resolved ?? false}
            currency={currency}
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              className={`rounded-md px-2.5 py-1 text-sm text-bambu-gray transition-colors hover:text-white ${focusRingCls}`}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={shippingMutation.isPending}
              className={`rounded-md border border-sky-400/40 px-2.5 py-1 text-sm text-sky-400 transition-colors hover:bg-sky-400/10 disabled:opacity-50 ${focusRingCls}`}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm items-baseline">
          <dt className="text-bambu-gray">{t('aito.shippingIsland')}</dt>
          <dd className="text-right min-w-0 truncate text-white">{shippingIslandLabel}</dd>
          <dt className="text-bambu-gray">{t('aito.shippingRecipient')}</dt>
          <dd className="text-right min-w-0 truncate text-white">{recipient}</dd>
          <dt className="text-bambu-gray">{t('aito.shippingPhone')}</dt>
          <dd className="flex justify-end min-w-0">
            <CopyableValue
              value={project.shipping_phone ?? ''}
              display={formatPhoneDisplay(project.shipping_phone ?? '')}
              label={t('aito.shippingPhone')}
              icon={Phone}
            />
          </dd>
          <dt className="text-bambu-gray">{t('aito.shippingService')}</dt>
          <dd className="text-right min-w-0 truncate text-white">{serviceName}</dd>
          <dt className="text-bambu-gray">{t('aito.shippingRate')}</dt>
          <dd className="text-right min-w-0 text-white">
            <Money currency={currency} value={project.shipping_price ?? 0} />
          </dd>
        </dl>
      )}
    </div>
  );
}
