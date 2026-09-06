"""Shared text-normalization helpers."""

import unicodedata


def fold_text(value: str | None, *, form: str = "NFKD") -> str:
    """Case- and accent-insensitive comparison key.

    ``form="NFKD"`` (the default, used by ``aito_shipping``) strips
    surrounding whitespace, lower-cases, decomposes accented characters
    with compatibility decomposition, and drops the resulting combining
    marks — so ``"  Société  "``, ``"SOCIÉTÉ"`` and ``"societe"`` all fold
    to the same key, and NFKD extras like the NBSP or the 'fi' ligature
    fold too (NBSP -> space, 'ﬁchier' -> 'fichier'). Tolerates ``None``
    (folds to ``""``) since callers often read this value back out of
    free-typed data that may be missing entirely.

    ``form="NFD"`` reproduces ``aito_quote_import``'s original, narrower
    pipeline byte-for-byte: canonical (not compatibility) decomposition of
    the raw value, drop combining marks, lower-case last, no upfront
    ``.strip()``. NFD does NOT fold an NBSP to a plain space or a ligature
    to its component letters, which matters there: the importer's
    boilerplate check compares a whole free-text row against a literal
    string, and Zoho/Word paste artifacts like NBSPs must NOT make an
    otherwise-different row look like that boilerplate. Do not merge the
    two orderings without re-checking both the importer's boilerplate
    match and the shipping label lookups.
    """
    if form == "NFD":
        decomposed = unicodedata.normalize("NFD", value or "")
        return "".join(char for char in decomposed if not unicodedata.combining(char)).lower()
    decomposed = unicodedata.normalize("NFKD", (value or "").strip().lower())
    return "".join(char for char in decomposed if not unicodedata.combining(char))
