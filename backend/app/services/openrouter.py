"""OpenRouter chat-completion client for the Aito project summary.

One job: turn a project's task drafts into a short factual French summary.
Configuration lives in the settings table (`openrouter_api_key` is write-only,
`openrouter_model` defaults to mistral-small — cheap and strong in French).
"""

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "mistralai/mistral-small"
TIMEOUT_S = 8.0

# Wire-field -> French service name, in the board's canonical order. Keys match
# AitoTaskCreate; a service is enabled when its cost is not None (0 = free but
# real — same None-vs-0 rule as everywhere else on the board).
_SERVICE_FIELDS = (
    ("scan_cost", "scan 3D"),
    ("modelisation_cost", "modélisation 3D"),
    ("impression_cost", "impression 3D"),
    ("usinage_cost", "usinage"),
)

_SYSTEM_PROMPT = (
    "Tu rédiges des résumés de projets pour un atelier de fabrication 3D en français. "
    "À partir de la liste des tâches, écris 1 à 2 phrases courtes et factuelles décrivant "
    "le travail à réaliser. Pas de prix, pas de formule de politesse, pas de liste à puces : "
    "uniquement le résumé."
)


class OpenRouterNotConfiguredError(Exception):
    """No API key in settings."""


class OpenRouterUpstreamError(Exception):
    """OpenRouter reachable but the call failed."""


def _task_lines(tasks: list[dict]) -> list[str]:
    """One human-readable line per task: title, enabled services, print params."""
    lines: list[str] = []
    for index, task in enumerate(tasks):
        title = (task.get("title") or "").strip() or f"Tâche {index + 1}"
        services = [name for field, name in _SERVICE_FIELDS if task.get(field) is not None]
        parts = [f"{title}: {', '.join(services) if services else 'aucun service'}"]
        if task.get("impression_cost") is not None:
            details = []
            if task.get("impression_color"):
                details.append(str(task["impression_color"]))
            if task.get("impression_weight_g") is not None:
                details.append(f"{task['impression_weight_g']:g} g")
            if task.get("impression_quantity") not in (None, 1):
                details.append(f"x{task['impression_quantity']}")
            if details:
                parts.append(f"({', '.join(details)})")
        description = (task.get("description") or "").strip()
        if description:
            parts.append(f"— {description}")
        lines.append(" ".join(parts))
    return lines


async def summarize_tasks(db: AsyncSession, tasks: list[dict]) -> tuple[str, str]:
    """Returns (summary, model). Raises the two module errors; never returns ""."""
    # Lazy import: settings helpers live in the routes module (house style —
    # see services/zoho.py doing exactly this).
    from backend.app.api.routes.settings import get_setting

    api_key = (await get_setting(db, "openrouter_api_key") or "").strip()
    if not api_key:
        raise OpenRouterNotConfiguredError()
    model = (await get_setting(db, "openrouter_model") or "").strip() or DEFAULT_MODEL

    payload = {
        "model": model,
        "max_tokens": 200,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": "\n".join(_task_lines(tasks))},
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
        summary = response.json()["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise OpenRouterUpstreamError("OpenRouter returned an unexpected payload") from e
    if not summary:
        raise OpenRouterUpstreamError("OpenRouter returned an empty summary")
    return summary, model
