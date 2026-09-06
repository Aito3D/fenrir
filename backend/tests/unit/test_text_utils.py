"""Unit tests for utils.text — the shared fold_text() comparison key."""

from backend.app.utils.text import fold_text


class TestFoldText:
    """Tests for fold_text()."""

    def test_none_folds_to_empty_string(self):
        assert fold_text(None) == ""

    def test_accents_are_stripped(self):
        assert fold_text("Société") == "societe"
        assert fold_text("Matériau") == "materiau"
        assert fold_text("Île") == "ile"

    def test_case_is_lowered(self):
        assert fold_text("SOCIÉTÉ") == "societe"

    def test_surrounding_whitespace_is_stripped(self):
        assert fold_text("  Île  ") == "ile"

    def test_nfkd_compatibility_decomposition(self):
        # NFKD (unlike NFD) decomposes compatibility characters such as the
        # 'fi' ligature and superscript digits into their plain equivalents.
        assert fold_text("ﬁchier") == "fichier"
        assert fold_text("m²") == "m2"

    def test_already_folded_value_is_unchanged(self):
        assert fold_text("societe") == "societe"

    def test_empty_string(self):
        assert fold_text("") == ""

    def test_nfd_form_keeps_nbsp_and_ligatures_unlike_the_nfkd_default(self):
        # form="NFD" is aito_quote_import's original pipeline: canonical
        # (not compatibility) decomposition, so an NBSP does NOT fold to a
        # plain space and a ligature does NOT fold to its component
        # letters -- unlike the NFKD default exercised above.
        assert fold_text("fichier\xa0non\xa0cede", form="NFD") == "fichier\xa0non\xa0cede"
        assert fold_text("fichier\xa0non\xa0cede") == "fichier non cede"
        assert fold_text("ﬁchier", form="NFD") == "ﬁchier"
        # Accent-stripping still works under NFD -- only the compatibility
        # extras (NBSP, ligatures, superscripts, ...) are the difference.
        assert fold_text("Société", form="NFD") == "societe"
