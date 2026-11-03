"""P1 Human Gate: approval boundary and confirmation semantics.

Text + behavior assertions only; fastapi is not imported so these run
without the HTTP stack.
"""
import pathlib
import unittest

from chef_ai_workspace.mutations import Proposal
from chef_ai_workspace.persistence_service import (
    LedgerIngredient, save_recipe_with_ledger, save_validated_mutation)

API = (pathlib.Path(__file__).resolve().parents[1] /
       "chef_ai_workspace/api.py").read_text()
DEMO = (pathlib.Path(__file__).resolve().parents[1] /
        "chef_ai_workspace/demo_api.py").read_text()


class HumanGateWiring(unittest.TestCase):
    def test_confirm_bodies_carry_no_client_confirmed_flag(self):
        # Model/client must not smuggle confirmation: extra fields forbidden
        # and trusted_user_confirmed is a server literal.
        self.assertIn('extra="forbid"', API)
        self.assertIn("save_recipe_crud(", API)
        self.assertNotIn("trusted_user_confirmed=body", API)
        self.assertNotIn("confirmed", API.split("class MutationBody")[1].split("verified_owner")[0])

    def test_demo_confirm_uses_server_literal(self):
        self.assertIn("save_recipe_crud(", DEMO)

    def test_no_route_calls_commit_rpc_directly(self):
        # Routes must save only through save_* orchestration; direct
        # repository.commit_*() or client.rpc("commit_*") calls bypass the
        # Human Gate. Capability checks via getattr are allowed.
        for src, name in ((API, "api.py"), (DEMO, "demo_api.py")):
            with self.subTest(route=name):
                self.assertNotIn("repository.commit_", src)
                self.assertNotIn('rpc("commit_', src)

    def test_old_path_accepts_no_ledger_writes(self):
        # Approval via the legacy path cannot create ingredients: there is
        # no ledger parameter to smuggle them through.
        with self.assertRaises(TypeError):
            save_validated_mutation(owner_id="u", trusted_user_confirmed=True,
                                    proposal=Proposal("r", 0, "q", ({"op": "set_title", "value": "x"},)),
                                    repository=object(),
                                    ledger=(LedgerIngredient("new", name="塩"),))


if __name__ == "__main__":
    unittest.main()
