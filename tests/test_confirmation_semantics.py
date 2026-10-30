"""trusted_user_confirmed=False still saves; it only keeps values assumed."""
import unittest
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.mutations import Proposal
from chef_ai_workspace.persistence_service import save_recipe_with_ledger


def tv(v):
    return TrackedValue(str(v), "confirmed", "user")


def quote(amount):
    return PriceQuote(tv(amount), "1", "g", "manual")


def recipe():
    return Recipe("r1", tv("Base"), (MaterialLine("m1", tv("塩"), tv("100"), "g",
                  price_override=quote("10")),), tv("500"))


class FakeRepo:
    def __init__(self):
        self.current = recipe()
        self.catalog = {}
        self.receipts = {}
    def load_owned_recipe(self, owner_id, recipe_id):
        return self.current
    def load_owned_catalog(self, owner_id, recipe):
        return dict(self.catalog)
    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get(request_id)
    def commit_recipe_with_ledger(self, **kw):
        self.receipts[kw["request_id"]] = (kw["payload_hash"], kw["base_revision"] + 1)
        return kw["base_revision"] + 1


class ConfirmationSemanticsTests(unittest.TestCase):
    def _send(self, confirmed, request):
        db = FakeRepo()
        out = save_recipe_with_ledger(
            owner_id="u", trusted_user_confirmed=confirmed,
            proposal=Proposal("r1", 0, request,
                              ({"op": "set_title", "value": "New"},)),
            repository=db)
        return out

    def test_unconfirmed_save_persists_as_assumed(self):
        out = self._send(False, "req-assumed-1")
        self.assertEqual(out.resulting_revision, 1)
        self.assertFalse(out.replayed)
        self.assertEqual(out.recipe.title.status, "assumed")

    def test_confirmed_save_marks_confirmed(self):
        out = self._send(True, "req-confirmed-1")
        self.assertEqual(out.recipe.title.status, "confirmed")


if __name__ == "__main__":
    unittest.main()
