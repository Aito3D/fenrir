# Aito × Zoho Books — client attribution design

Date: 2026-07-25
Status: approved by user (brainstorming session)

## Goal

Attach a Zoho Books client to every Aito project. The create-project modal gains a
required client search field (typeahead against Zoho Books contacts); cards show the
client name, phone, and a sequential project number. Aito projects move from
localStorage to the backend database. A new Settings tab manages the Zoho credentials.

## Decisions made

| Decision | Choice |
|---|---|
| Zoho product | Zoho Books (contacts API, organization-scoped) |
| Search strategy | Live proxied search through the backend, 300 ms debounce (no local contact cache) |
| Project storage | Backend DB (new `aito_projects` table); board shared across devices/users |
| Client on creation | **Required** — creation blocked when Zoho is not configured/unreachable |
| Deletion | Soft delete only (`status` flips to `deleted`; rows are never removed) |
| Project number | Auto-increment primary key, displayed as `#<id>`; never reused (soft delete) |
| Credentials | Stored in the existing `settings` key-value table; secrets write-only from the UI |

## Backend

### Zoho service — `backend/app/services/zoho.py`

- Reads settings keys: `zoho_client_id`, `zoho_client_secret`, `zoho_refresh_token`,
  `zoho_organization_id`, `zoho_base_url` (default `https://www.zohoapis.eu`),
  `zoho_accounts_url` (default `https://accounts.zoho.eu`).
- Token manager: exchanges the refresh token for an access token at
  `{accounts_url}/oauth/v2/token`, caches it in memory, refreshes ~5 min before
  expiry, retries once on 401 (token may have been revoked/rotated).
- `search_contacts(query)` → `GET {base_url}/books/v3/contacts` with
  `organization_id` + `search_text`, mapped to
  `{id, name, company_name, phone, mobile, email}`.
- Zoho/network failures map to HTTP 502 with a translatable error message; a
  not-configured state maps to 409.

Credentials are seeded into the local DB manually by the operator (one-off local
command). They are never committed to the repository — not in code, not in this spec,
not in tests.

### Aito model — `backend/app/models/aito_project.py`

| Column | Type | Notes |
|---|---|---|
| `id` | int PK autoincrement | doubles as the visible project number `#id` |
| `description` | text | required |
| `column` | string | `devis` / `model` / `print` / `finish` |
| `position` | int | ordering within a column |
| `status` | string | `active` / `deleted` (soft delete; default `active`) |
| `client_id` | string nullable | Zoho contact id (nullable for migrated legacy cards) |
| `client_name` | string nullable | snapshot at attach time |
| `client_phone` | string nullable | snapshot; phone or mobile, whichever exists |
| `created_at` | datetime | server default now |
| `updated_at` | datetime | onupdate now |

Client data is a **snapshot**: cards render with zero Zoho calls and survive Zoho
outages; later edits in Zoho do not retro-update existing cards (accepted tradeoff).

Registration gotchas (repo-specific): the model must be added to the three model
import lists; the new table is created via the existing additive migration path in
`backend/app/core/database.py:run_migrations()`.

### Routes

- `GET  /api/v1/aito/` — active projects ordered by column + position (`aito:read`)
- `POST /api/v1/aito/` — create; rejects missing description or missing client
  (`aito:create`)
- `POST /api/v1/aito/import` — batch import of clientless legacy cards; returns 409
  unless the board has zero rows (`aito:create`). Used only by the one-time
  localStorage migration.
- `PATCH /api/v1/aito/{id}/move` — `{column, position}` (`aito:update`)
- `DELETE /api/v1/aito/{id}` — sets `status='deleted'` (`aito:delete`)
- `GET /api/v1/zoho/contacts?q=` — proxied search, min 2 chars (`aito:create`)
- `GET /api/v1/zoho/status` — `{configured: bool, reachable: bool}`; requires ANY of
  `aito:create` | `settings:read` (an any-of permission dependency), so both the
  modal and the settings Test button can call it

New permissions `aito:read/create/update/delete` are registered in the permission
list **and** the API-key permission classification (repo gotcha). Zoho credential
editing rides on the existing `settings:update`.

### localStorage migration

On AitoPage load: if `aito-board-v1` exists in localStorage and `GET /aito/` returns
an empty board, send all stored cards to `POST /aito/import` (clientless — they
predate the requirement), preserving column + order, then remove the localStorage
key. Silent, one-time; the import endpoint's empty-board guard makes a double-fire
harmless.

## Frontend

### Settings — new `zoho` tab

- Added to `validTabs` in `SettingsPage.tsx` + settings-search registry entries.
- Six inputs; `zoho_client_secret` and `zoho_refresh_token` are write-only password
  fields (display `••••` once saved; GET returns masked values).
- Save button + **Test connection** button calling `/zoho/status`, showing
  reachable / unreachable with the underlying error message.

### Create-project modal

- Client combobox on top, description below. Create disabled until both are set.
- ≥2 chars → 300 ms debounce → dropdown: name, company, phone per row; spinner while
  loading; empty-state row; inline error row when Zoho is unreachable.
- Full keyboard support: ↑/↓ to navigate, Enter to select, Escape closes the
  dropdown first, then the modal.
- Selection collapses into a chip (name + phone, × to clear and re-search).
- Not configured (`/zoho/status`): the field is replaced by a notice linking to the
  Zoho settings tab; creation is blocked.

### Card & board

- Card header line: `#id` + client name (bold); phone underneath as a `tel:` link;
  then description; footer keeps created date (updated date in tooltip) + delete.
- Legacy cards without a client simply omit the client line.
- Board state moves from localStorage to React Query. Drag & drop uses optimistic
  updates: UI moves instantly, `PATCH /move` fires in background, rollback + toast
  on failure. Existing dnd-kit interaction and motion system unchanged.
- Delete keeps the ConfirmModal; message updated to say the project is hidden, not
  destroyed.

### i18n

All new strings translated in all 12 locale files (parity gate enforces key sets,
placeholders, and rejects untranslated English copies).

## Error handling summary

| Failure | Behavior |
|---|---|
| Zoho not configured | Modal shows notice + settings link; creation blocked; board unaffected |
| Zoho unreachable / auth failure | Inline error row in dropdown; Test button shows details; 502 from proxy |
| Drag PATCH fails | Optimistic rollback + error toast |
| Delete | Always soft; no data loss possible from the UI |

## Testing

- **Backend**: token manager (refresh flow, expiry cache, 401 retry), contact
  mapping, aito CRUD, required-client validation, soft delete filtering,
  permission checks per route.
- **Frontend (Vitest + msw)**: combobox debounce/select/clear/keyboard/not-configured
  states, card rendering with and without client, localStorage one-time migration,
  optimistic move rollback.

## Out of scope (YAGNI)

- Editing/replacing a card's client after creation
- Contact cache / background sync (can be layered on later without UI changes)
- Restoring soft-deleted projects from the UI (data is safe in the DB)
- Zoho product auto-detection or multi-organization support
