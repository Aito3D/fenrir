"""OpenRouter chat-completion client for the Aito AI text features.

Two jobs, one API key. `summarize_tasks` turns a project's task drafts into a
short factual French summary; `proofread_text` corrects one field's French
spelling without rewriting it. Configuration lives in the settings table
(`openrouter_api_key` is write-only, `openrouter_model` defaults to
mistral-small — cheap and strong in French). Proofreading pins its own model
rather than following that setting: a summary can trade prose quality for
price, but a correction that reformulates is a wrong correction.
"""

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "mistralai/mistral-small"
# Pinned, not a setting: see the module docstring. Every proofread call uses it.
PROOFREAD_MODEL = "mistralai/mistral-small-2603"
# Longest field we will pay to correct. Matches AitoProofreadRequest.text's own
# cap — the API rejects anything longer before it reaches this module.
PROOFREAD_MAX_CHARS = 2000
TIMEOUT_S = 8.0

# Wire-field -> description field -> French service name, in the board's
# canonical order. Keys match AitoTaskCreate; a service is enabled when its
# cost is not None (0 = free but real — same None-vs-0 rule as everywhere
# else on the board).
_SERVICE_FIELDS = (
    ("scan_cost", "scan_description", "scan 3D"),
    ("modelisation_cost", "modelisation_description", "modélisation 3D"),
    ("impression_cost", "impression_description", "impression 3D"),
    ("usinage_cost", "usinage_description", "usinage"),
)

_SYSTEM_PROMPT = (
    "Tu rédiges des résumés de projets pour un atelier de fabrication 3D en français. "
    "À partir de la liste des tâches, écris 1 à 2 phrases courtes et factuelles décrivant "
    "le travail à réaliser. Écris tous les nombres en chiffres (« 3 pièces », « 2 supports »), "
    "jamais en toutes lettres. Pas de prix, pas de formule de politesse, pas de liste à puces : "
    "uniquement le résumé."
)


_PROOFREAD_SYSTEM_PROMPT = (
    "Tu es correcteur orthographique pour un atelier de fabrication 3D. "
    "Corrige l'orthographe, les accents, la grammaire, la ponctuation et les majuscules du texte fourni, "
    "en français. Ne reformule pas, n'ajoute rien, ne supprime rien, ne traduis pas : garde les mêmes mots, "
    "le même ordre et le même sens. Laisse tels quels les nombres, les unités, les références, les noms "
    "propres et les termes techniques. Si le texte est déjà correct, renvoie-le à l'identique. "
    "Réponds uniquement par le texte corrigé, sans guillemets, sans commentaire, sans explication."
)


_PICKUP_SYSTEM_PROMPT = (
    "Tu rédiges des SMS pour Aito3D, un atelier de fabrication 3D situé à Arue, en Polynésie française. "
    "Préviens le client que ses pièces sont prêtes et qu'il peut venir les récupérer à nos bureaux à Arue. "
    "Écris 1 à 2 phrases courtes, chaleureuses et simples. Commence exactement par « Ia Ora na » "
    "(I majuscule, comme dans Igloo — jamais « la Ora na »). "
    "Nomme chaque pièce de la liste fournie, toutes sans exception, réduite au nom de l'objet : "
    "pas de couleurs, pas de dimensions, pas de matériaux, pas de prix, et jamais les étapes de "
    "fabrication (impression, modélisation, scan, usinage). "
    "Exemple — pièces « Cache de vis de jante » et « Cache attelage Fox » : "
    "« Ia Ora na, le cache de vis de jante et le cache attelage Fox sont prêts et vous attendent "
    "à nos bureaux à Arue. » "
    "Termine par la signature « Aito3D » seule sur sa propre ligne, après un retour à la ligne. "
    "Réponds uniquement par le SMS, sans guillemets, sans commentaire, sans explication."
)


class OpenRouterNotConfiguredError(Exception):
    """No API key in settings."""


class OpenRouterUpstreamError(Exception):
    """OpenRouter reachable but the call failed."""


def _task_lines(tasks: list[dict]) -> list[str]:
    """One human-readable line per task: title, enabled services, print params."""
    lines: list[str] = []
    for index, task in enumerate(tasks):
        # Bounds what we ship to the paid API — a pathological draft must not
        # blow up the prompt (and the bill).
        title = ((task.get("title") or "").strip() or f"Tâche {index + 1}")[:500]
        # The count rides on the service name, so a machining-only project
        # does not lose "3 pièces" from the summary. Printing's own quantity
        # stays here too rather than being stated twice in its detail group
        # below (which now carries only colour and weight).
        services = []
        for cost_field, _, name in _SERVICE_FIELDS:
            if task.get(cost_field) is None:
                continue
            quantity = task.get(f"{cost_field.removesuffix('_cost')}_quantity")
            services.append(f"{name} x{quantity}" if quantity and quantity > 1 else name)
        parts = [f"{title}: {', '.join(services) if services else 'aucun service'}"]
        if task.get("impression_cost") is not None:
            details = []
            if task.get("impression_color"):
                details.append(str(task["impression_color"]))
            if task.get("impression_weight_g") is not None:
                details.append(f"{task['impression_weight_g']:g} g")
            if details:
                parts.append(f"({', '.join(details)})")
        # Per-service free text, bounded like the title — these are the only
        # prose fields left now the task-level description is gone.
        for cost_field, description_field, _ in _SERVICE_FIELDS:
            if task.get(cost_field) is None:
                continue
            description = (task.get(description_field) or "").strip()[:500]
            if description:
                parts.append(f"— {description}")
        lines.append(" ".join(parts))
    return lines


async def _api_key(db: AsyncSession) -> str:
    """The configured key, or OpenRouterNotConfiguredError."""
    api_key = (await _setting(db, "openrouter_api_key")).strip()
    if not api_key:
        raise OpenRouterNotConfiguredError()
    return api_key


async def _setting(db: AsyncSession, key: str) -> str:
    # Lazy import: settings helpers live in the routes module (house style —
    # see services/zoho.py doing exactly this).
    from backend.app.api.routes.settings import get_setting

    return await get_setting(db, key) or ""


async def _chat(
    api_key: str, model: str, system: str, user: str, max_tokens: int, *, raise_on_truncation: bool = False
) -> str:
    """One chat completion, returned as its stripped message content.

    Every failure mode — transport, non-200, unexpected payload, empty answer —
    raises OpenRouterUpstreamError, so callers have exactly two error cases to
    handle (this one and "no key") whatever they asked the model for.

    `raise_on_truncation` is an opt-in: only proofread_text sets it. A
    truncated correction is a sentence cut off mid-thought, and swapping it
    straight into the field it came from would silently drop whatever came
    after the cut — so that caller treats finish_reason=="length" as another
    upstream failure. summarize_tasks runs its own draft-to-summary call
    against a hard-coded 200-token budget, where hitting the cap is common,
    not exceptional, and BASE always returned the (possibly truncated)
    summary rather than raising — that behavior is unchanged here.
    """
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            response = await client.post(
                OPENROUTER_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
    except httpx.HTTPError as e:
        raise OpenRouterUpstreamError(f"OpenRouter request failed: {e}") from e
    if response.status_code != 200:
        raise OpenRouterUpstreamError(f"OpenRouter returned {response.status_code}")
    try:
        choice = response.json()["choices"][0]
        content = choice["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, ValueError, AttributeError) as e:
        raise OpenRouterUpstreamError("OpenRouter returned an unexpected payload") from e
    if raise_on_truncation and choice.get("finish_reason") == "length":
        # The model hit max_tokens before finishing: `content` is a sentence
        # cut off mid-thought, not a correction. Returning it as a normal
        # answer would let a caller swap it straight into the field it came
        # from. Raise instead, so the caller treats this like any other
        # upstream failure and leaves the user's original text untouched.
        raise OpenRouterUpstreamError("OpenRouter truncated its answer (finish_reason=length)")
    if not content:
        raise OpenRouterUpstreamError("OpenRouter returned an empty answer")
    return content


async def summarize_tasks(db: AsyncSession, tasks: list[dict]) -> tuple[str, str]:
    """Returns (summary, model). Raises the two module errors; never returns ""."""
    api_key = await _api_key(db)
    model = (await _setting(db, "openrouter_model")).strip() or DEFAULT_MODEL
    summary = await _chat(api_key, model, _SYSTEM_PROMPT, "\n".join(_task_lines(tasks)), max_tokens=200)
    return summary, model


def _normalize_pickup(message: str) -> str:
    """The two guarantees prompting alone cannot give.

    1. The greeting: Mistral has been seen answering « la Ora na » — a
       lowercase L where « Ia Ora na » wants a capital I, an easy confusion in
       most fonts and a mistake the client WILL notice. Fixed mechanically
       rather than trusted to the prompt.
    2. The signature: « Aito3D » must sit alone on its own line. When the
       model appends it to the last sentence instead, the line break is
       inserted here.
    """
    stripped = message.strip()
    if stripped[:9].lower() == "la ora na" and stripped[:1] in "lL":
        stripped = "Ia Ora na" + stripped[9:]
    if stripped.endswith("Aito3D") and not stripped.removesuffix("Aito3D").endswith("\n"):
        body = stripped.removesuffix("Aito3D").rstrip()
        # A trailing period the signature was glued onto stays with the body.
        stripped = f"{body}\nAito3D"
    return stripped


async def pickup_message(
    db: AsyncSession, description: str, client_name: str | None = None, parts: list[str] | None = None
) -> tuple[str, str]:
    """The "come and collect your parts" SMS draft. Returns (message, model).

    `parts` is the task titles — the names the client knows the work by — and
    the prompt requires every one of them in the message, reduced to the
    object's name. The project description rides along as context for a card
    with no tasks (an imported quote), where it is the only naming there is.
    The prompt forbids the technical detail both fields carry — the message
    tells the client to come, not what they ordered. Raises the two module
    errors; never returns "".
    """
    api_key = await _api_key(db)
    model = (await _setting(db, "openrouter_model")).strip() or DEFAULT_MODEL
    # Bounded like _task_lines' fields: a pathological description must not
    # blow up the prompt or the bill.
    lines = [f"Description du projet : {description.strip()[:500]}"]
    part_names = [p.strip()[:200] for p in (parts or []) if p and p.strip()]
    if part_names:
        # Its own labelled block, one line per part, matching the prompt's
        # "chaque pièce de la liste fournie" — a comma-joined list invites the
        # model to treat it as one long part name.
        lines.append("Pièces :")
        lines.extend(f"- {name}" for name in part_names[:20])
    if client_name and client_name.strip():
        lines.append(f"Client : {client_name.strip()[:200]}")
    message = await _chat(api_key, model, _PICKUP_SYSTEM_PROMPT, "\n".join(lines), max_tokens=200)
    # Same quote-stripping proofread_text needs, for the same reason: telling
    # the model not to wrap its answer is not a guarantee, and this text goes
    # to a customer's phone verbatim. The empty original means "always strip
    # a wrapping pair"; a reply that was ONLY a quote pair falls back to the
    # raw answer rather than "" (and _chat already refused an empty answer).
    return _normalize_pickup(_unquote(message, "") or message), model


def _unquote(corrected: str, original: str) -> str:
    """Strip one layer of quotes the model wrapped the answer in.

    Instructing it not to is not a guarantee, and a title that comes back as
    `"Capot"` would otherwise land in the field — and on the quote — with the
    quotes in it. Only stripped when the ORIGINAL had no such pair, so a user
    who deliberately quoted their own text keeps it.
    """
    for opening, closing in (('"', '"'), ("«", "»"), ("“", "”"), ("'", "'")):
        if (
            len(corrected) >= 2
            and corrected.startswith(opening)
            and corrected.endswith(closing)
            and not (original.startswith(opening) and original.endswith(closing))
        ):
            return corrected[1:-1].strip()
    return corrected


async def proofread_text(db: AsyncSession, text: str) -> tuple[str, str]:
    """Correct one field's French spelling. Returns (corrected, model).

    Correction only — the prompt forbids reformulating, adding or removing —
    because the caller swaps the answer straight into the field the user just
    left, and anything beyond a fix is words they did not write ending up on a
    quote. Raises the two module errors; never returns "".
    """
    api_key = await _api_key(db)
    # Bounded twice over: the request schema caps this at PROOFREAD_MAX_CHARS,
    # and a correction is the same length as its input, so the answer needs no
    # more room than the question plus a little slack for added accents and
    # punctuation.
    source = text.strip()[:PROOFREAD_MAX_CHARS]
    corrected = await _chat(
        api_key,
        PROOFREAD_MODEL,
        _PROOFREAD_SYSTEM_PROMPT,
        source,
        # Tokens, sized from a CHARACTER count, so this has to assume a
        # worst-case (i.e. token-dense) ratio rather than a typical one:
        # French prose heavy in accents, digits and references can tokenise
        # under 2 chars/token, so len(source)//2 was not enough headroom and
        # a long, dense field would come back truncated. 1.5 chars/token is
        # conservative for French; PROOFREAD_MAX_CHARS already bounds the
        # worst case, so no further cap is needed here.
        max_tokens=int(len(source) / 1.5) + 120,
        raise_on_truncation=True,
    )
    unquoted = _unquote(corrected, source)
    # A reply that is exactly a quote pair (`""`, `«  »`) passes _unquote's
    # len>=2 check and strips to "". That is not an upstream failure — the
    # model did answer — so raising here would mislabel it; and returning the
    # quote characters themselves would put punctuation-only garbage in the
    # field. `source` is guaranteed non-empty (the request schema rejects a
    # blank field before this is ever called), so falling back to it is the
    # same outcome as "nothing needed correcting": the caller sees its own
    # text unchanged, exactly as if the model had echoed it back.
    return unquoted or source, PROOFREAD_MODEL
