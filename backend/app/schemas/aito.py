"""Pydantic DTOs for the Aito production board."""

import re
from datetime import datetime
from typing import Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

AitoColumn = Literal["devis", "waiting", "scan", "model", "print", "finish", "done"]

# The Zoho quote-status vocabulary. A named alias (rather than inlining the
# Literal on the field below) so `_degrade_unknown_quote_status` can check
# membership against the exact same set the type declares, via `get_args`,
# instead of maintaining a second hand-written list that could drift.
#
# Public, not underscored, because the import path is no longer its only
# consumer: services/aito_quote_status.py's `adopt_quote_status` checks the
# same set before writing a status onto a project, so the sync worker cannot
# store one the board's rules do not understand either. Books' own set is
# WIDER than this one — 'invoiced' is the value that caused the bug that guard
# exists for — so this list is the board's vocabulary, not Books'.
AitoQuoteStatus = Literal["draft", "sent", "viewed", "accepted", "declined", "expired"]
QUOTE_STATUS_VALUES = frozenset(get_args(AitoQuoteStatus))

# Shape checks only, mirroring backend/app/api/routes/zoho.py's ZohoContactCreate's
# email philosophy. Both fields are optional — only a non-empty malformed value is
# rejected. Unlike Zoho's own _check_phone (which enforces the canonical `+CC-NNN...`
# the manual create form always produces via clientDraft.ts's formatPhone), a client's
# phone/email here can also arrive VERBATIM from a Zoho contact via the quote-import
# flow (see services/aito_quote_import.py:_client_snapshot, which passes contact.get
# ("mobile")/("phone") straight through with no reformatting) — so the phone check
# must accept whatever human-typed shape Zoho itself was happy to store
# ("+689 87 00 00 02", "0687654321", ...), not just the app's own canonical format.
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
# Digits, spaces and the handful of punctuation marks phone numbers are conventionally
# written with. The real guard against garbage is the "at least 6 digits" check below,
# not this character allowlist.
_PHONE_CHARS_RE = re.compile(r"^[0-9+\-\s().\/]+$")
_MIN_PHONE_DIGITS = 6


def _check_email(value: str) -> str:
    value = value.strip()
    if value and not _EMAIL_RE.match(value):
        raise ValueError("Enter a valid email address")
    return value


def is_plausible_phone(value: str) -> bool:
    """The same shape check `_check_phone` enforces, exposed as a predicate
    so callers that would rather degrade a value than reject a whole request
    (see services/aito_quote_import.py's `_client_snapshot`) can reuse the
    exact rule instead of re-deriving it. An empty/whitespace-only value is
    considered plausible — the caller decides what to do with blanks."""
    value = value.strip()
    if not value:
        return True
    digit_count = sum(c.isdigit() for c in value)
    return bool(_PHONE_CHARS_RE.match(value)) and digit_count >= _MIN_PHONE_DIGITS


def _check_phone(value: str) -> str:
    value = value.strip()
    if not value:
        return value
    if not is_plausible_phone(value):
        raise ValueError("Enter a valid phone number")
    return value


# The four networks the picker offers. A fixed tuple, not free text: the
# frontend renders one icon and one label per id (SOCIAL_NETWORKS in
# frontend/src/utils/clientDraft.ts must stay in step), and an id we cannot
# render is worse on the card than no channel at all.
SOCIAL_NETWORKS = ("messenger", "instagram", "whatsapp", "tiktok")


class AitoClientSocialInput(BaseModel):
    """The optional social channel, shared by create and update.

    Handle validation is deliberately just "non-empty after trimming": a
    WhatsApp handle is a phone number and an Instagram one is not, and four
    patterns for platforms we do not control would drift. Nothing downstream
    turns the value into a link, so a value we cannot parse costs nothing.
    """

    client_social_network: str | None = Field(default=None, max_length=20)
    client_social_handle: str | None = Field(default=None, max_length=100)

    @field_validator("client_social_network")
    @classmethod
    def _known_network(cls, value: str | None) -> str | None:
        if value is not None and value not in SOCIAL_NETWORKS:
            raise ValueError(f"client_social_network must be one of {', '.join(SOCIAL_NETWORKS)}")
        return value

    @model_validator(mode="after")
    def _pair_social(self):
        """Both fields are written together or not at all.

        The early return is load-bearing, not a fast path: pydantic v2's
        __setattr__ adds the name to `model_fields_set`, so assigning here
        unconditionally would make every AitoProjectUpdate look like it
        mentioned both keys — and update_project's
        `model_dump(exclude_unset=True)` would then NULL a stored handle on an
        unrelated description edit.
        """
        if not ({"client_social_network", "client_social_handle"} & self.model_fields_set):
            return self
        if "client_social_handle" not in self.model_fields_set:
            # The network was mentioned but the handle was not. A body like
            # `{"client_social_network": "tiktok"}` alone would otherwise fall
            # through to `update_project`'s `model_dump(exclude_unset=True)`,
            # which only NULLs the fields it sees — so the network would
            # change while the handle stayed unmentioned (untouched), leaving
            # the merged row an orphaned network with the OLD handle still
            # attached to it. Rejecting here is what makes "change the
            # network, keep the handle" not a thing a partial update can do —
            # the design's own words. A network explicitly cleared to null
            # needs no handle to go with it.
            if self.client_social_network is not None:
                raise ValueError("client_social_handle is required when client_social_network is set")
            return self
        handle = (self.client_social_handle or "").strip()
        if not handle:
            # A blank handle is not a channel. Dropping the network with it is
            # what stops a cleared field leaving "instagram" behind, pointing at
            # nothing. Both assignments are intended to mark the fields as set:
            # the caller DID mention this pair, and meant to clear it.
            self.client_social_handle = None
            self.client_social_network = None
            return self
        if self.client_social_network is None:
            raise ValueError("client_social_network is required when client_social_handle is set")
        self.client_social_handle = handle
        return self


class AitoShippingIsland(BaseModel):
    key: str
    label: str


class AitoShippingService(BaseModel):
    key: str
    name: str
    # None when this item was never matched in Books. The drawer then requires
    # the operator to type a price instead of pre-filling one.
    rate: float | None
    islands: list[AitoShippingIsland]


class AitoShippingServicesResponse(BaseModel):
    services: list[AitoShippingService]
    # False when Books has never been reachable. The islands are served
    # regardless — they are static app data and need no network.
    catalogue_resolved: bool


class AitoShippingInput(BaseModel):
    """The four required fields plus an optional price override.

    `shipping_service` is deliberately absent: the server derives it from the
    island and never trusts a client-supplied value.
    """

    shipping_island: str | None = Field(default=None, max_length=50)
    shipping_first_name: str | None = Field(default=None, max_length=100)
    shipping_last_name: str | None = Field(default=None, max_length=100)
    shipping_phone: str | None = Field(default=None, max_length=50)
    shipping_price: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    model_config = ConfigDict(extra="ignore")


class AitoTaskBase(BaseModel):
    """A NULL cost means the service is disabled; 0 stays meaningful as free."""

    title: str | None = Field(default=None, max_length=200)
    scan_description: str | None = None
    modelisation_description: str | None = None
    impression_description: str | None = None
    usinage_description: str | None = None
    # `allow_inf_nan=False` is NOT set here, on purpose, for the same reason
    # `max_length` is not set here on the description fields two lines below:
    # AitoTaskResponse also inherits from AitoTaskBase, and a constraint here
    # would make reading back a row that ALREADY stores a non-finite value
    # (accepted and persisted before this task, or by a future write path
    # this task did not touch) raise a 500 out of GET /aito/{id}/tasks
    # instead of serialising it as `null` the way BASE always has. The
    # write-side reject lives on AitoTaskCreate/AitoTaskUpdate below instead.
    scan_cost: float | None = Field(default=None, ge=0)
    modelisation_cost: float | None = Field(default=None, ge=0)
    usinage_cost: float | None = Field(default=None, ge=0)
    impression_printer_id: int | None = None
    impression_filament_id: int | None = None
    impression_weight_g: float | None = Field(default=None, ge=0)
    impression_time_min: int | None = Field(default=None, ge=0)
    impression_quantity: int | None = Field(default=None, ge=1)
    impression_color: str | None = Field(default=None, max_length=100)
    impression_cost: float | None = Field(default=None, ge=0)
    # gt=0: a 0% discount is expressed as null, never stored — see the model.
    impression_discount_pct: float | None = Field(default=None, gt=0, le=100)
    # ge=1: there is no zero-unit line. None reads as 1.
    scan_quantity: int | None = Field(default=None, ge=1)
    modelisation_quantity: int | None = Field(default=None, ge=1)
    usinage_quantity: int | None = Field(default=None, ge=1)
    # gt=0 for the same reason impression_discount_pct uses it: a 0% discount
    # is expressed as null, never stored.
    scan_discount_pct: float | None = Field(default=None, gt=0, le=100)
    modelisation_discount_pct: float | None = Field(default=None, gt=0, le=100)
    usinage_discount_pct: float | None = Field(default=None, gt=0, le=100)
    scan_done: bool = False
    modelisation_done: bool = False
    impression_done: bool = False
    usinage_done: bool = False


class AitoTaskCreate(AitoTaskBase):
    # 10_000 is generous headroom over anything a human types — it exists to keep a
    # pathological payload from ballooning the row or the AI summarizer's prompt.
    # Bounded here (and on AitoTaskUpdate) rather than on AitoTaskBase: AitoTaskResponse
    # also inherits from AitoTaskBase, and a bound there would make reading back a row
    # already stored above the cap raise instead of just refusing to write a new one.
    scan_description: str | None = Field(default=None, max_length=10_000)
    modelisation_description: str | None = Field(default=None, max_length=10_000)
    impression_description: str | None = Field(default=None, max_length=10_000)
    usinage_description: str | None = Field(default=None, max_length=10_000)
    # Same reasoning as the description caps above, and the same precedent
    # this task's own base-class comment documents: redeclared here (and on
    # AitoTaskUpdate) rather than on AitoTaskBase, because AitoTaskResponse
    # inherits AitoTaskBase too and must keep reading back an already-stored
    # non-finite value as `null`, matching BASE, rather than 500ing.
    scan_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    modelisation_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    usinage_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    impression_weight_g: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    impression_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    impression_discount_pct: float | None = Field(default=None, gt=0, le=100, allow_inf_nan=False)


class AitoTaskUpdate(AitoTaskBase):
    """Only keys present in the body are written — an omitted key is left alone,
    an explicit null clears the field. That is what lets one service be
    disabled without disturbing its siblings."""

    # See AitoTaskCreate for why this is redeclared per-request-model instead of on
    # AitoTaskBase.
    scan_description: str | None = Field(default=None, max_length=10_000)
    modelisation_description: str | None = Field(default=None, max_length=10_000)
    impression_description: str | None = Field(default=None, max_length=10_000)
    usinage_description: str | None = Field(default=None, max_length=10_000)
    # See AitoTaskCreate for why this is redeclared per-request-model instead
    # of on AitoTaskBase.
    scan_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    modelisation_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    usinage_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    impression_weight_g: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    impression_cost: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    impression_discount_pct: float | None = Field(default=None, gt=0, le=100, allow_inf_nan=False)


class AitoTaskResponse(AitoTaskBase):
    id: int
    project_id: int
    position: int
    created_at: datetime
    updated_at: datetime


class AitoProjectCreate(AitoShippingInput, AitoClientSocialInput):
    # 10_000 is generous headroom over anything a human types — it exists to keep a
    # pathological payload from ballooning the row or the AI summarizer's prompt.
    description: str = Field(min_length=1, max_length=10_000)
    # 50 matches the AitoProject.client_id column (String(50)) — see the
    # T-003 comment on AitoProjectUpdate.client_id below for why the bound
    # sits here and on AitoProjectUpdate only, never on a response model.
    # Deliberately no character-class pattern (unlike quote_id's below): a
    # Zoho contact id is opaque and this app never interpolates it into a
    # URL path or trusts it as a filesystem-adjacent token the way quote_id
    # is, so there is nothing here for a charset to protect against — only
    # length matches the column it is stored in.
    client_id: str = Field(min_length=1, max_length=50)
    # Caps mirror ZohoContactCreate's company_name/email/phone — the same contact data,
    # captured here instead of a Zoho round-trip.
    client_name: str = Field(min_length=1, max_length=200)
    client_phone: str | None = Field(default=None, max_length=50)
    client_email: str | None = Field(default=None, max_length=200)
    client_is_company: bool | None = None
    # Books estimate ids are opaque alphanumerics. The charset matters: this value
    # is interpolated into the Books URL path, and httpx normalises dot segments,
    # so an unconstrained id can walk out of /books/v3 onto any Zoho endpoint with
    # the org's OAuth token. `zoho._seg` escapes it too — this rejects the request
    # outright rather than forwarding a nonsense id upstream.
    quote_id: str | None = Field(default=None, max_length=50, pattern=r"^[A-Za-z0-9_-]+$")
    quote_number: str | None = Field(default=None, max_length=50)
    quote_date: str | None = Field(default=None, max_length=10)
    quote_total: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    quote_url: str | None = Field(default=None, max_length=300)
    quote_salesperson: str | None = Field(default=None, max_length=200)
    # Restricted to the Zoho vocabulary — an import usually carries one of
    # these (it is read straight off the Books estimate), and a hand-made
    # card only ever sends 'sent'/'accepted'/'declined' through the dedicated
    # /quote-status route, never here. 'accepted'/'declined' are DECIDED
    # statuses: see _decided_status_needs_a_quote_id below for why they are
    # gated separately from the vocabulary check.
    #
    # A blank or out-of-vocabulary value (Books emits both —
    # aito_quote_import.build_preview reads `estimate.get("status") or ""`,
    # and a real org can carry a status this app has never catalogued, e.g.
    # 'invoiced') is degraded to None by `_degrade_unknown_quote_status`
    # below rather than rejected, the same call `_client_snapshot` in
    # aito_quote_import.py already makes for `client_phone`: a field the
    # import cannot get the user to fix is not worth failing the whole
    # import over.
    quote_status: AitoQuoteStatus | None = Field(default=None)
    # 300, not AitoSummarizeRequest.tasks' 50 below, because THIS field has two
    # live callers with very different shapes, and the tighter of the two is
    # not the binding one. Caller 1: the create drawer (AiSummaryPanel calls
    # /aito/summarize with the same task array on every open, and that
    # endpoint's own 50 is untouched — see its field below — so a drawer
    # operator already loses the AI summary past 50 tasks; that is pre-existing
    # and unrelated to this cap). Caller 2, found after 50 shipped: the Zoho
    # quote-import preview (aito_quote_import.build_preview) builds exactly one
    # task per HEADER GROUP of the imported Books estimate
    # (`_build_task(group) for group in group_lines(lines)`), and posts that
    # whole list here — an estimate with more than the cap's header groups
    # would have its WHOLE IMPORT rejected, not just lose a summary. A header
    # group is at most one recognised line per service in SERVICE_RANK (scan,
    # modelisation, impression, usinage — 4 total; a repeated or
    # lower-ranked service opens a new group), so 300 tasks tolerates a Books
    # estimate with up to 1200 recognised service line items — a workshop
    # quote with 300 distinct physical parts, each individually scanned,
    # modelled, printed and machined, in one estimate. No real Zoho estimate
    # this app has imported has come close; this is headroom, not a realistic
    # ceiling. A single task also carries its own `quantity` for the
    # impression service, so a large batch of IDENTICAL prints is one task,
    # not many. Chosen inside the user-approved 200-500 range.
    tasks: list[AitoTaskCreate] = Field(default_factory=list, max_length=300)

    @field_validator("client_email")
    @classmethod
    def _validate_client_email(cls, value: str | None) -> str | None:
        return value if value is None else _check_email(value)

    @field_validator("client_phone")
    @classmethod
    def _validate_client_phone(cls, value: str | None) -> str | None:
        return value if value is None else _check_phone(value)

    @field_validator("quote_status", mode="before")
    @classmethod
    def _degrade_unknown_quote_status(cls, value):
        """Runs before the `Literal` check, so a blank or unrecognised STRING
        (see the field comment above) becomes None instead of a 422 — the
        request is still validated against the closed vocabulary, just with
        the unusable value already swapped out. Only strings are degraded:
        a value already in the vocabulary passes through untouched, and
        anything that is not even a string (e.g. `quote_status: 42`) is left
        for the `Literal` to reject as the genuinely malformed body it is.

        Also left for the `Literal` to reject: any string longer than 30
        characters. Pre-T-009, this field carried `max_length=30`; that
        constraint was dropped when the field became a `Literal` (any
        over-length value was rejected by the vocabulary check anyway, so
        the length cap was unobservable), but degrading unknown SHORT
        statuses here made the gap observable again — without this check, a
        >30-char status would silently become None instead of 422ing as it
        did at BASE. Bounding the degrade path at 30 restores that parity."""
        if isinstance(value, str) and len(value) <= 30 and value not in QUOTE_STATUS_VALUES:
            return None
        return value

    @field_validator("quote_url")
    @classmethod
    def _quote_url_must_be_https(cls, value: str | None) -> str | None:
        """The board renders this as a trustworthy-looking link labelled with
        the quote number, so it must actually go where it looks like it goes.
        The app itself only ever generates `https://books.zoho.<region>/...`
        URLs, so restricting to https costs nothing legitimate while closing
        off `javascript:`, `data:`, bare `http://` and relative values."""
        if not value:
            return value
        if not value.startswith("https://"):
            raise ValueError("quote_url must use the https scheme")
        return value

    @model_validator(mode="after")
    def _decided_status_needs_a_quote_id(self):
        """'accepted'/'declined' are DECISIONS, not free text — the only
        legitimate way one can arrive on a brand-new card is a Books quote
        that was already decided before it was imported, which always carries
        a quote_id. A hand-made card reaches those statuses exclusively
        through POST /{id}/quote-status (Permission.AITO_UPDATE, the 409
        terminal-transition guards, a recorded actor). Accepting one here too
        would let anyone holding only aito:create drive an irreversible
        acceptance straight through to the live Zoho estimate on the next
        sync tick, with no actor on the timeline and none of those guards."""
        if self.quote_status in ("accepted", "declined") and self.quote_id is None:
            raise ValueError("quote_status 'accepted'/'declined' requires a quote_id (import only)")
        return self


class AitoProjectImportItem(BaseModel):
    # 10_000 matches every other description in this module (see
    # AitoProjectCreate.description) — this was the one left uncapped.
    description: str = Field(min_length=1, max_length=10_000)
    column: AitoColumn
    position: int = Field(ge=0)


class AitoProjectImport(BaseModel):
    # 1000 mirrors library.py's BulkFileOperation.file_ids cap — the
    # codebase's existing precedent for a one-shot batch import, not the
    # per-task-list 50 above (a different shape: this is a one-time
    # localStorage-board migration, not a project a human builds row by row
    # in a drawer). No current frontend code calls this route at all; 1000 is
    # a generous ceiling on a legacy migration board that was, in practice,
    # always a small, actively-curated Kanban rather than an archive.
    projects: list[AitoProjectImportItem] = Field(max_length=1000)


class AitoProjectMove(BaseModel):
    column: AitoColumn
    position: int = Field(ge=0)


class AitoTaskReorder(BaseModel):
    """The complete desired order of one project's tasks. Complete, not a
    delta: the handler validates it as exactly the current id set, which is
    what turns a stale client list (concurrent add/delete) into a 409 instead
    of silent corruption. 300 mirrors AitoProjectCreate's task-list cap."""

    task_ids: list[int] = Field(min_length=1, max_length=300)


class AitoProjectUpdate(AitoShippingInput, AitoClientSocialInput):
    """Content edits from the card detail panel. Ordering (column/position) is
    owned by the /move endpoint and deliberately not accepted here."""

    description: str | None = Field(default=None, min_length=1, max_length=10_000)
    # 50, matching the AitoProject.client_id column (String(50)) and
    # AitoProjectCreate.client_id above — bounded here (the WRITE path) and
    # not on a response model, for the same reason AitoTaskCreate/Update's
    # description/cost caps sit off of AitoTaskBase (see that class's
    # comment): AitoProjectResponse.client_id is its own independent field,
    # not inherited from either create/update schema, so it keeps reading
    # back an already-stored over-length value unchanged rather than 500ing.
    # No character-class pattern — see AitoProjectCreate.client_id's comment
    # for why quote_id's `^[A-Za-z0-9_-]+$` does not apply to this field.
    client_id: str | None = Field(default=None, max_length=50)
    client_name: str | None = Field(default=None, max_length=200)
    client_phone: str | None = Field(default=None, max_length=50)
    client_email: str | None = Field(default=None, max_length=200)
    client_is_company: bool | None = None
    # Optimistic-concurrency token: the AitoProject.version the client last
    # rendered. Mismatch -> 409 version_conflict, nothing written. Optional so
    # API-key callers that never fetched a version keep working; the frontend
    # always sends it.
    expected_version: int | None = None

    @field_validator("description")
    @classmethod
    def _description_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("description must not be blank")
        return value

    @field_validator("client_email")
    @classmethod
    def _validate_client_email(cls, value: str | None) -> str | None:
        return value if value is None else _check_email(value)

    @field_validator("client_phone")
    @classmethod
    def _validate_client_phone(cls, value: str | None) -> str | None:
        return value if value is None else _check_phone(value)


AitoFlag = Literal["urgent", "sav", "pause"]


class AitoFlagUpdate(BaseModel):
    """Body of PATCH /aito/{id}/flag. A single required field: this route
    exists to write exactly one flag, so `exclude_unset` semantics (which
    `AitoProjectUpdate` needs) would only make "absent" ambiguous here.

    `None` is the third state — no flag — not "leave it alone"."""

    flag: AitoFlag | None


class AitoContactedUpdate(BaseModel):
    """Body of PATCH /aito/{id}/contacted.

    A bool rather than the timestamp itself, deliberately: WHEN the client was
    told is the server's fact to record, and letting a client post its own
    time would put the card's age — and the Done gate — at the mercy of a
    wrong clock in a browser.
    """

    contacted: bool


class AitoTaskStepsResponse(BaseModel):
    """One task's steps, for the board card's per-task rows.

    Mirrors TaskSteps in services/aito_board_rules.py. Both lists are in
    canonical SERVICES order; `done` is a subset of `services`, and a service
    priced None appears in neither — it is absent from the job, not pending.
    `title` is the task's own name, "" when it has none — the frontend
    supplies the fallback name ("Task N") for that case.
    """

    services: list[str]
    done: list[str]
    title: str = ""


class AitoProjectResponse(BaseModel):
    id: int
    description: str
    column: AitoColumn
    position: int
    status: str
    client_id: str | None
    client_name: str | None
    client_phone: str | None
    client_email: str | None
    client_is_company: bool | None
    client_social_network: str | None
    client_social_handle: str | None
    quote_id: str | None
    quote_number: str | None
    quote_date: str | None
    quote_total: float | None
    quote_url: str | None
    quote_salesperson: str | None
    quote_status: str | None
    # When the quote last transitioned into 'accepted' — see the column
    # comment on AitoProject. NULL when there is no known acceptance moment;
    # the card then ages from created_at.
    quote_accepted_at: datetime | None
    created_by: str | None
    # 'idle' | 'pending' | 'error' | 'locked' | 'unmanaged' — see the column
    # comment on AitoProject.quote_sync_state for what each means.
    quote_sync_state: str
    # True once Books reports the estimate invoiced. Sticky — see the column
    # comment on AitoProject.quote_invoiced. Separate from quote_sync_state ==
    # 'locked', which also covers tax-exclusive quotes that were never billed.
    quote_invoiced: bool
    # A local board signal, never synced to Zoho — see the column comment on
    # AitoProject.flag. Display ordering only: the board ranks cards into
    # three tiers within their column — urgent and sav rise to the top as
    # peers, pause sinks to the bottom, unflagged sits in between — without
    # rewriting stored `position` values.
    flag: AitoFlag | None
    # When the client was told the job is ready — see the column comment on
    # AitoProject.client_contacted_at. NULL means nobody has told them yet,
    # and while it is NULL the project cannot be archived: `move_project`
    # refuses Finish -> Done. The board card reads it to know whether to show
    # the "call the client" state or the ordinary Done button.
    client_contacted_at: datetime | None
    quote_sync_error: str | None
    # Why the status reconciler is blocked, if it is, and what Books read when
    # it was recorded — 'conflict' (both sides decided and differ) or
    # 'rejected' (Books refused our push). Independent of quote_sync_state:
    # the panel renders this whatever the sync state is, which is the point of
    # it being a stored fact rather than a sentence in quote_sync_error.
    quote_status_block: Literal["conflict", "rejected"] | None
    quote_status_remote: str | None
    # Aggregates over the project's tasks, so the board card can show a summary
    # without GET /aito/ shipping every task row. Required, never defaulted:
    # see _to_response in the routes module.
    task_count: int
    tasks_total: float
    task_services: list[str]
    # Steps, not services: two tasks each carrying a scan are two steps, where
    # task_services reports 'scan' once. The board card's progress bar is
    # steps_done / steps_total, and hides itself entirely when steps_total is
    # 0 — an unpriced project has nothing to measure.
    steps_total: int
    steps_done: int
    # One entry per task, in the same order the detail panel lists them, so
    # the card's pill rows and the panel's task rows line up. This is the only
    # per-task detail GET /aito/ ships; everything else stays an aggregate.
    task_steps: list[AitoTaskStepsResponse]
    # The services with at least one UNTICKED step, in canonical order —
    # exactly what evaluate() takes. task_services above is the union of
    # ENABLED services, a different set that cannot substitute for it: the
    # optimistic frontend predicts a card's column from this field.
    task_pending: list[str]
    # Why this card cannot be dragged between columns, or None when it can
    # (Finish <-> Done only). Derived, never stored — see
    # services/aito_board_rules.evaluate. The frontend renders its lock badge
    # and computes its allowed droppables from this and nothing else.
    move_lock: Literal["quote", "waiting", "declined", "steps"] | None
    # Optional air freight. `shipping_island is None` IS "no shipping"; the
    # frontend tests that field and nothing else.
    shipping_island: str | None
    shipping_service: str | None
    shipping_first_name: str | None
    shipping_last_name: str | None
    shipping_phone: str | None
    shipping_price: float | None
    # The Books item's display name, resolved from the cached catalogue so the
    # board list does not force the frontend to join every card against the
    # services endpoint. None when the catalogue has never resolved; the panel
    # falls back to the service key's own label. No default: `_to_response`
    # requires its `shipping_names` argument for exactly this reason — a
    # future call site that forgot it should fail loudly, not validate a
    # silently-blanked field.
    shipping_service_name: str | None
    # Content-fields revision — see AitoProject.version. The detail panel
    # echoes this back as expected_version on PATCH.
    version: int
    created_at: datetime
    updated_at: datetime


class AitoQuoteStatusUpdate(BaseModel):
    """The three transitions the board can drive. Zoho has no /status/draft, and
    `viewed` and `expired` are things that happen TO a quote rather than
    decisions anyone makes — they only ever arrive from Zoho."""

    status: Literal["sent", "accepted", "declined"]


class AitoQuoteStatusResponse(BaseModel):
    """``zoho_synced`` is a transport detail, so it rides alongside the project
    rather than on it: the frontend writes ``project`` straight into the board
    cache with setQueryData, and a cached board row has no business carrying
    the outcome of one request."""

    project: AitoProjectResponse
    zoho_synced: bool
    # True when the requested status was already the current one: nothing was
    # written, recorded, or pushed. The frontend skips its toasts on this.
    no_op: bool = False


class AitoQuoteEmailRecipient(BaseModel):
    """One address this quote can be emailed to, as Books offers it."""

    email: str
    name: str
    contact_person_id: str


class AitoQuoteEmailContent(BaseModel):
    """The send modal's prefill.

    ``body`` is Books' rendered HTML. Sanitised with DOMPurify and rendered by
    ``ZohoEmailPreview`` inside an iframe with ``sandbox=""`` and an
    in-document CSP — never inlined into the app document. (Not, as this
    docstring used to claim, displayed as plain text: that was true before
    the sandboxed preview component landed and has been stale since.)
    """

    subject: str
    body: str
    recipients: list[AitoQuoteEmailRecipient]
    # The address to preselect: the project's own client_email when it has
    # one, else Books' first recipient. None only when there is nobody to
    # send to, which the modal renders as an explicit message rather than an
    # empty dropdown.
    default_email: str | None


class AitoQuoteEmailRequest(BaseModel):
    to: str


class AitoQuoteEmailResponse(BaseModel):
    """``marked_sent`` is a transport detail, exactly like
    ``AitoQuoteStatusResponse.zoho_synced``: ``project`` goes straight into
    the board cache and has no business carrying one request's outcome.

    Tri-state, not a plain bool: ``True`` means the card moved to Waiting as
    part of this send; ``None`` means the move was never attempted because
    the card was not in the Quote column (a legitimate re-send from Waiting
    or later — not a failure); ``False`` means the move was attempted and
    the ``except SQLAlchemyError`` degrade in ``send_quote_email`` kicked in
    — the email went out (see that handler's docstring) but the card did
    not move and needs a manual nudge. Collapsing the last two into one
    ``False`` used to make a genuine failure indistinguishable from "not
    applicable", and the only client that read this field ignored it
    either way; see ``useSendQuoteMutation`` for how it now reacts to
    ``False`` specifically."""

    project: AitoProjectResponse
    marked_sent: bool | None


class AitoInvoiceEmailContent(BaseModel):
    """The send-invoice modal's prefill.

    ``recipients`` reuses ``AitoQuoteEmailRecipient``: an address Books offers
    has the same three fields whichever document it was read from, and a
    parallel model with identical fields would be noise.

    ``invoice_id`` and ``invoice_number`` name the document this prefill is
    about. The modal echoes the id back on POST so the send is pinned to the
    invoice the operator actually saw — the server still owns the candidate
    set and only checks the id for membership.
    """

    subject: str
    body: str
    recipients: list[AitoQuoteEmailRecipient]
    # The address to preselect: the project's own client_email when it has
    # one, else Books' first recipient. None only when there is nobody to
    # send to, which the modal renders as an explicit message rather than an
    # empty dropdown.
    default_email: str | None
    invoice_id: str
    invoice_number: str


class AitoInvoiceEmailRequest(BaseModel):
    """``invoice_id`` may only NARROW the server's own candidate set — see
    ``send_invoice_email``. Optional, and omitting it sends the newest, so a
    caller that has not read the card yet is still served."""

    to: str
    invoice_id: str | None = None


class AitoInvoiceResponse(BaseModel):
    """The Invoice card's contents, read live from Books on panel open.

    Not snapshotted onto the project like the quote fields are: an invoice's
    interesting field is whether it has been PAID, and a stored copy of that
    is wrong the moment the client pays. The trade is that this card needs
    Zoho reachable, where the Quote card renders from the database.

    ``balance`` rides along with ``total`` because "paid" is the one thing
    the operator opening this card wants to know, and Books' ``status`` alone
    does not distinguish a part-paid invoice from an unpaid one.
    """

    id: str
    number: str
    date: str
    due_date: str
    total: float
    balance: float
    currency_code: str
    status: str
    # Deep link into the Books web app. Built per-request rather than stored,
    # for the same reason the rest of this model is: nothing here is snapshot.
    url: str
    # How many invoices this estimate has THAT BELONG TO THIS PROJECT'S
    # CUSTOMER — counted after that filter, not before. Advertising invoices
    # the guard deliberately excluded would be worse than undercounting: it
    # would send the operator looking for a document this app will refuse to
    # show them.
    #
    # Books allows an estimate to be invoiced in parts; the card renders the
    # newest and uses this to say so when there are others, rather than
    # silently implying it is the only one.
    invoice_count: int


class AitoEventResponse(BaseModel):
    id: int
    occurred_at: datetime
    occurred_until: datetime | None
    kind: str
    actor_class: str
    actor_name: str | None
    subject_type: str | None
    subject_id: int | None
    subject_label: str | None
    changes: list[dict] | None
    detail: dict | None
    note: str | None

    model_config = {"from_attributes": True}


class AitoEventPage(BaseModel):
    events: list[AitoEventResponse]
    has_more: bool


class AitoNoteCreate(BaseModel):
    """The ONLY thing a client may append to the timeline.

    Deliberately carries no kind, actor or timestamp: the handler fixes all
    three. A body that could name its own kind could fabricate an acceptance.
    """

    note: str = Field(min_length=1, max_length=2000)

    @field_validator("note")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("note must not be blank")
        return stripped


class AitoSummarizeRequest(BaseModel):
    """Task drafts to summarize — the create-drawer sends its local drafts, so
    these are AitoTaskCreate shapes, not persisted rows."""

    tasks: list[AitoTaskCreate] = Field(min_length=1, max_length=50)


class AitoSummarizeResponse(BaseModel):
    summary: str
    model: str


class AitoProofreadRequest(BaseModel):
    """One field's text to spell-check. Sent on blur, so it is one title or one
    service description — never a whole project."""

    # 2000: the longest a service description gets in practice, and the cap the
    # service trusts (openrouter.PROOFREAD_MAX_CHARS). Bounds what a paste can
    # cost per blur.
    text: str = Field(min_length=1, max_length=2000)

    @field_validator("text")
    @classmethod
    def _reject_blank(cls, v: str) -> str:
        """Whitespace-only is nothing to correct: 422 rather than a paid call
        that can only echo it back. Returns the TRIMMED text, so the answer the
        field swaps in cannot reintroduce the user's stray whitespace."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("text must not be blank")
        return stripped


class AitoProofreadResponse(BaseModel):
    text: str
    model: str


class AitoPickupMessageResponse(BaseModel):
    """The AI-drafted "come and collect" SMS. A draft, never sent as-is: the
    panel shows it editable and only /pickup-sms sends anything."""

    message: str
    model: str


class AitoPickupSmsRequest(BaseModel):
    """The message to relay — the user may have edited the draft, so this is
    what actually goes to the phone, not what the model wrote."""

    # 1000: several times a long SMS, and bounds what a paste can push into a
    # lock-screen notification.
    message: str = Field(min_length=1, max_length=1000)

    @field_validator("message")
    @classmethod
    def _reject_blank(cls, v: str) -> str:
        """Whitespace-only is not a message. Trimmed, so the SMS never opens
        or closes with stray newlines from the textarea."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("message must not be blank")
        return stripped


class AitoPickupSmsResponse(BaseModel):
    sent: bool = True
