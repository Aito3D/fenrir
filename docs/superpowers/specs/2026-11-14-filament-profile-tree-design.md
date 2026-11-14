# Filament profile tree + Orca Cloud sync — design

Date: 2026-11-14 · Status: draft for approval

## Why

The shop calibrates every filament in OrcaSlicer, once, on one machine (typically X2D, 0.4 nozzle, white).
It then needs that filament on every machine in the farm, every nozzle size and every colour it stocks.
Neither Orca nor Bambu Studio can express "this profile is that one, except for these values": a user preset
can only inherit from a Bambu *system* preset, never from another user preset. So today every machine × colour
copy is rebuilt by hand, there is no parent edit, and copies drift apart.

Fenrir becomes the place where filament profiles live as **trees**, and the master copy of them. Orca Cloud is
the delivery pipe to every PC.

Three goals, in the user's words:
1. a save of all filament profiles;
2. the same profiles on every computer;
3. calibrate on one machine, derive for the others, and fine-tune per machine and per colour.

## The tree

One tree per **brand + material** (e.g. "Polymaker PETG").

```
Polymaker PETG                      ← root: the calibrated profile (calibration source: X2D 0.4 White)
├── X2D / H2S / H2D / H2C           ← machine level
│   └── 0.2 / 0.4 / 0.6 / 0.8       ← nozzle level
│       └── White, Red, Black, …    ← colour level (leaves; each leaf = one Orca profile)
```

- Machines and nozzles come from a **standard list**: machines X2D, H2S, H2D, H2C; nozzles 0.2, 0.4, 0.6, 0.8.
  The list is a setting, not hard-coded, so a new printer is one edit.
- **0.2 is skipped for abrasive filaments.** Fenrir detects CF/GF from the material name (PETG-CF, PA6-GF, …);
  the root has a "skip 0.2" switch to correct the guess either way.
- **Colours are picked and named by the user** per tree (name + swatch hex). Not derived from inventory.
- Every combination exists: 4 machines × 4 nozzles × N colours (12 × N for CF/GF). A leaf with nothing of its
  own is fully inherited and costs nothing to manage.

### Where a value comes from

Each leaf's full profile is resolved in this order, later wins:

1. **Bambu system preset for that machine + nozzle**: the Bambu base matching the root's base filament type
   (e.g. "Bambu PETG Basic @BBL H2C 0.8 nozzle"). This brings Bambu's per-machine/per-nozzle defaults.
2. **Root values that follow the material**: temperatures, flow ratio, cooling, retraction, shrinkage, cost,
   everything the user calibrated, *except* the nozzle-bound settings below.
3. **Machine-level own values**.
4. **Nozzle-level own values**.
5. **Colour-level own values**.

**The root stores only the user's own values**, i.e. what the calibrated profile sets over its Bambu base, the
same diff shape the existing presets already use (19–31 keys each). It never stores the full flattened X2D
profile, so X2D-specific Bambu values (start G-code, limits, chamber) never leak onto other machines; each
leaf gets those from its own Bambu base in step 1. *(Claude's call, from the user's "start from Bambu".)*

**Nozzle-bound settings are never copied from the root**: max volumetric speed and pressure advance. They come
from Bambu (step 1) unless set at machine, nozzle or colour level. Example: tune PA once on H2S › 0.4 and every
colour under it picks it up. The list is a constant in code, easy to extend.

**Override rule (user's):** a node with its own value for a setting keeps it when an ancestor changes. The UI
always shows that the value is the node's own and shows the inherited value next to it, with "use parent" to
drop the override.

### Dual-nozzle machines

H2D / H2C (and X2D if dual) get **one value set, written to both extruders**. High-flow hotends are not used.
Per-extruder and high-flow variants are out of scope but must not be designed out.

## Naming in Orca

Orca preset names are unique identifiers, so leaves carry a fixed suffix:

**`BRAND MATERIAL - COLOR @MACHINE NOZZLE`**, e.g. `Polymaker PETG - Red @H2S 0.4`.

Each leaf's `compatible_printers` is exactly its own printer preset (e.g. `Bambu Lab H2S 0.4 nozzle`), so with
"H2S 0.4" selected Orca shows one entry per colour per material. Inside Fenrir the suffix is never shown; the
tree position says it.

## The pipeline

1. User calibrates in Orca → Orca Cloud holds the profile.
2. User clicks **SYNC** in Fenrir.
3. Fenrir **pulls** from Orca Cloud, folds changes into the trees, then **pushes** every resolved leaf.
4. User may edit any leaf in Orca on any PC (e.g. `… PETG - Red @H2S 0.2`) → Orca Cloud spreads it to every PC
   on its own.
5. Next SYNC: that edit lands as **an own value on exactly that leaf** (shown orange, inherited value beside it).

SYNC is the one button. Pull first, then push. Nothing runs in the background.

### Pull rules

- **Edit to a leaf** → the changed settings become that leaf's own values (only settings that differ from what
  the leaf would inherit).
- **Edit to the calibration-source leaf** (the root's machine/nozzle/colour, e.g. X2D 0.4 White) → updates the
  **root**, so it flows down. This is how recalibration works.
- **Profile not in any tree** (a newly calibrated filament named `BRAND MATERIAL - COLOR`, no suffix) → Fenrir
  asks the user to confirm brand, material, colour and the machine/nozzle it was calibrated on, makes it a new
  tree's root, and builds the children.
- **Leaf deleted in Orca** → Fenrir does not delete from the tree; it reports it and re-pushes it. (Fenrir owns
  the tree; deleting is done in Fenrir.)
- **Same setting changed in Fenrir and in Orca since the last sync** → Fenrir shows both values and the user
  picks. Never a silent winner.
- Non-filament presets (process, printer) and filament presets Fenrir doesn't manage are left alone.

### Push rules

- Every leaf is pushed as a full resolved profile that inherits from its Bambu system base (step 1).
- Adding a colour or machine in Fenrir creates the missing leaves; removing one deletes its leaves from Orca
  Cloud on the next SYNC.
- **Before every push, Fenrir snapshots the full current Orca Cloud filament state.** Any sync can be rolled
  back from a snapshot. Snapshots are kept (bounded count is the builder's call).

### First SYNC (migration)

- The 56 existing Fenrir filament profiles are the starting point (verified on the shop server 2026-11-14:
  5 brands, named `BRAND MATERIAL - COLOR`, each a diff over a Bambu system preset, each currently compatible
  with several machines at 0.4, one PA6-GF at 0.6, one PA12-CF with no compatible printers).
- Order: per brand + material group, the user **first confirms the calibration source** (colour + machine/nozzle;
  default White, else the first colour; machine/nozzle from the profile's `inherits`). *(Claude's call.)*
- The source colour's profile (minus nozzle-bound settings) becomes the root. **The calibration-source leaf always
  has zero own values**, so a pull edit on it maps cleanly to the root. Every other colour becomes a colour leaf
  whose differences from the root are its own values. *(Claude's call.)*
- **Existing max volumetric speed / pressure advance are not dropped:** they become own values on the nozzle
  node of every machine the old profile listed in `compatible_printers` (e.g. H2S › 0.4, H2D › 0.4, H2C › 0.4),
  or on the colour leaf where colours of the same group differ. *(Claude's call; protects against the
  anti-goal of silently losing a value.)*
- A profile with no compatible printers (today: SUNLU PA12-CF) is treated as calibrated on its `inherits`
  machine at 0.4, and the user confirms it in the source step. *(Claude's call.)*
- Presets that exist only in Orca Cloud are **not** folded in: the user chose Fenrir's 56 as the starting point.
  They survive in the pre-push snapshot.
- Fenrir snapshots, then **deletes every user filament preset in Orca Cloud** and pushes the trees. Process and
  printer presets are untouched. This step shows a clear count and needs an explicit confirm.

## The page

Tree on the left, settings panel on the right (mockup option A, chosen by the user). It replaces today's grouped
view on `FilamentProfilesPage`.

- Left: brand + material › machine › nozzle › colour, folding. A count badge on a node means "N own values
  below/at this node". Colour leaves show their swatch.
- Right: breadcrumb (`Polymaker PETG › H2S › 0.6 › Red`) and every setting. Own values are marked, with the
  inherited value beside them and "use parent". Inherited values are muted and say where they come from
  ("from H2S › 0.6", "from Polymaker PETG", "from Bambu H2C 0.8").
- Editing at any node is the "bulk edit": change PA at H2S › 0.4 and all its colours follow.
- SYNC button with a result summary (pulled / folded / conflicts / pushed / deleted) and access to snapshots.
- The existing Zoho price sync keeps working and writes `filament_cost` on the **root** (verified 2026-11-14:
  price is identical across colours in every group today). A colour can still override it like any setting.

**The tree is the only way to change a managed profile.** `filament_presets` rows for managed leaves become
generated output of the tree. The per-preset editor, bulk edit modal and file import on today's page are
replaced by the tree page and SYNC pull. Read-only consumers (slicing, spools, local `bambu-sync` export) keep
reading the generated rows. *(Claude's call; otherwise the rows and the tree drift apart, which is the problem
this feature exists to fix.)*

Mockup: `.superpowers/brainstorm/6095-1794695466/content/family-tree.html` (gitignored scratch).

## Constraints

- **Existing consumers of `filament_presets` must keep working.** Server slicing (`slicer_pipelines`,
  `pipeline_eligibility`), spool ↔ preset links (`spool_filament_preset`, `spool`), K-profile defaults
  (`filament_profile_default`), project snapshots, library, inventory, cloud routes and the Zoho price sync all
  read that table. A preset row referenced today must still resolve to a sensible profile after migration.
- Orca Cloud credentials/tokens follow the existing pattern in `services/orca_cloud.py`; never logged.
- Additive DB changes only (new tables via `create_all`, ALTERs in `run_migrations`), dialect-aware
  (SQLite + PostgreSQL). Registration checklist in CLAUDE.md applies (model import lists, permissions, i18n in
  all locales).
- Tests stub Orca Cloud; no live pushes from the dev DB.

## Risk to clear first (gate before building the sync)

Fenrir pairs with Orca Cloud at scope `sync:read` under client ID `oc_app_e873d49ce7dbcc7dca8ba386`
(`services/orca_cloud.py`), which appears to be upstream Bambuddy's registration. Pushing needs `sync:write`
and the push/delete endpoints of `/api/v1/external/sync/*`, which are not publicly documented (BamDude, another
fork, does push with its own registered client ID). Before building push:

1. confirm the push/delete endpoint shapes (Orca Cloud team, OrcaSlicer issue #14028, or BamDude's docs);
2. confirm this client ID may request `sync:write`, or register Fenrir's own;
3. switching scope forces one re-pair.

**Phasing (user's decision, 2026-11-14):** the user is not contacting the Orca Cloud team for now.

- **Phase 1 (build now):** tree storage + migration of the 56 presets, resolver, the tree page, SYNC = **pull only**
  (fold Orca edits into the trees, per the pull rules), and an **"Export for Orca"** bundle of resolved leaves for
  import on each PC. No writes to Orca Cloud, so no wipe in phase 1.
- **Phase 2 (later, once write access is sorted out):** SYNC push, snapshots before push, and the one-time
  wipe-and-repush of Orca Cloud. Phase 1 must not need reworking to add it.

In phase 1 the "first SYNC" migration is local: build the trees from the 56 presets; the Orca Cloud wipe waits
for phase 2.

**Fallback if write access is refused:** the tree, page and pull still ship; delivery becomes an "Export for
Orca" bundle the user imports on each PC (File › Import). The existing `exportZip.ts` is a starting point.

## Non-goals (for now)

- High-flow hotends and per-extruder values.
- The printer-side pressure advance (K) tables.
- Bambu Studio sync (local-folder `bambu-sync`); the user works in Orca.
- Automatic/background sync.
- Deriving colours from inventory.

## Anti-goals

- Any sync that silently overwrites or deletes a value the user set, in either direction.
- A tree the user can't read at a glance: where every value comes from must always be visible.
- Losing profiles: no destructive Orca Cloud operation without a snapshot first.

## Left to the builder

- Storage shape of the tree and own values (e.g. node table + per-node overrides JSON), and how resolved leaves
  map onto `filament_presets` rows.
- Matching the Bambu system base per machine + nozzle (the 2,087-row `filament_base_presets` index exists), and
  what to do when Bambu has no preset for a combination.
- Which settings count as "temperatures, cooling, retraction…" beyond the explicit nozzle-bound list; the rule is
  "everything except nozzle-bound flows from the root".
- How spool/pipeline references to a migrated multi-machine preset are remapped.
- Snapshot retention, conflict UI details, page responsiveness on phones.
