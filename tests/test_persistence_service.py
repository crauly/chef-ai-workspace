import unittest
from dataclasses import replace
from chef_ai_workspace import Recipe, MaterialLine, PriceQuote, TrackedValue
from chef_ai_workspace.mutations import Proposal, MutationError
from chef_ai_workspace.persistence_service import save_validated_mutation

def tv(v):
    return TrackedValue(str(v), "confirmed", "user")

def recipe():
    return Recipe("r1", tv("Pasta"), (MaterialLine("m1",tv("海老"),tv("3"),"尾",
                  price_override=PriceQuote(tv("150"),"1","尾","manual")),),tv("1000"))

class FakeRepository:
    def __init__(self):
        self.current = recipe()
        self.commits = []
        self.receipts = {}
        self.fail = False
    def load_owned_recipe(self, owner_id, recipe_id):
        if owner_id != "user-a" or recipe_id != self.current.id:
            raise ValueError("Not found")
        return self.current
    def load_owned_catalog(self, owner_id, recipe):
        return {}
    def get_mutation_receipt(self, owner_id, request_id):
        return self.receipts.get(request_id)
    def commit_recipe_revision(self, *, owner_id, recipe_id, request_id,
                               base_revision, state, title, cost_snapshot,
                               payload_hash, save_version):
        if self.fail:
            raise RuntimeError("database unavailable")
        if request_id in self.receipts:
            previous_hash, revision = self.receipts[request_id]
            if payload_hash != previous_hash:
                raise ValueError("request collision")
            return revision
        if base_revision != self.current.revision:
            raise ValueError("stale")
        self.commits.append((state,cost_snapshot,save_version))
        self.receipts[request_id]=(payload_hash,base_revision+1)
        self.current=replace(self.current,revision=base_revision+1,
                             materials=(replace(self.current.materials[0],
                                               quantity=tv(state["materials"][0]["quantity"]["value"])),))
        return self.current.revision

class BridgeTests(unittest.TestCase):
    def proposal(self, request="req-1"):
        return Proposal("r1",0,request,({"op":"set_material_quantity","material_id":"m1","value":"4","unit":"尾"},))
    def run_mutation(self, repo, proposal=None, **kwargs):
        return save_validated_mutation(owner_id="user-a",trusted_user_confirmed=True,
            proposal=proposal or self.proposal(),repository=repo,**kwargs)
    def test_persist_after_validation(self):
        db=FakeRepository()
        out=self.run_mutation(db, save_version=True)
        self.assertEqual(out.resulting_revision,1)
        self.assertEqual(len(db.commits),1)
        self.assertEqual(db.commits[0][1]["effective_quotes"]["m1"]["effective_quote"]["amount_jpy"]["value"],"150")
        self.assertEqual(db.commits[0][1]["total_cost_jpy"],"600")
    def test_retry_returns_existing_state_without_second_commit(self):
        db=FakeRepository()
        first=self.run_mutation(db)
        second=self.run_mutation(db)
        self.assertFalse(first.replayed)
        self.assertTrue(second.replayed)
        self.assertEqual(second.resulting_revision, 1)
        self.assertEqual(len(db.commits), 1)

    def test_request_id_collision_rejected_before_mutation(self):
        db=FakeRepository()
        self.run_mutation(db)
        with self.assertRaises(MutationError):
            self.run_mutation(db, Proposal("r1",0,"req-1",({"op":"set_title","value":"Different"},)))
        self.assertEqual(len(db.commits), 1)

    def test_overlapping_retry_rechecks_receipt(self):
        from dataclasses import asdict
        from hashlib import sha256
        from chef_ai_workspace.persistence_service import canonical_json
        proposal = self.proposal()
        digest = sha256(canonical_json({
            "proposal": asdict(proposal), "confirmed": True,
            "save_version": False
        }).encode("utf-8")).hexdigest()
        class RacingRepository(FakeRepository):
            def __init__(self):
                super().__init__()
                self.reads = 0
            def get_mutation_receipt(self, owner_id, request_id):
                self.reads += 1
                if self.reads == 1:
                    self.current = replace(self.current, revision=1)
                    self.receipts[request_id] = (digest, 1)
                    return None
                return super().get_mutation_receipt(owner_id, request_id)
        db = RacingRepository()
        result = self.run_mutation(db, proposal)
        self.assertTrue(result.replayed)
        self.assertEqual(result.resulting_revision, 1)
        self.assertEqual(db.commits, [])

    def test_invalid_number_raises_mutation_error(self):
        db=FakeRepository()
        p=Proposal("r1",0,"req-new",({"op":"set_selling_price","value_jpy":"abc"},))
        with self.assertRaises(MutationError):
            self.run_mutation(db,p)
        self.assertEqual(db.commits,[])

    def test_inherited_quote_included_in_snapshot(self):
        from chef_ai_workspace import Ingredient
        db=FakeRepository()
        db.current=replace(db.current,materials=(replace(
            db.current.materials[0],ingredient_id="ingredient-1",
            price_mode="inherit",price_override=None),))
        def catalog(owner_id, recipe):
            self.assertEqual(owner_id,"user-a")
            return {"ingredient-1":Ingredient("ingredient-1","海老",
                   PriceQuote(tv("150"),"1","尾","shared-ingredient"))}
        db.load_owned_catalog=catalog
        out=self.run_mutation(db,save_version=True)
        self.assertEqual(out.resulting_revision,1)
        self.assertEqual(db.commits[0][1]["total_cost_jpy"],"600")
        self.assertEqual(db.commits[0][1]["effective_quotes"]["m1"]["effective_quote"]["amount_jpy"]["value"],"150")

    def test_bad_batch_never_calls_database(self):
        db=FakeRepository()
        bad=Proposal("r1",0,"req-1",({"op":"unknown"},))
        with self.assertRaises(MutationError):
            self.run_mutation(db,bad)
        self.assertEqual(db.commits,[])
    def test_database_failure_keeps_prior_state(self):
        db=FakeRepository();db.fail=True
        with self.assertRaises(RuntimeError):
            self.run_mutation(db)
        self.assertEqual(db.current.revision,0)
    def test_owner_is_required(self):
        with self.assertRaises(MutationError):
            save_validated_mutation(owner_id="",trusted_user_confirmed=True,
                proposal=self.proposal(),repository=FakeRepository())
    def test_confirmation_decision_must_be_bool(self):
        with self.assertRaises(MutationError):
            save_validated_mutation(owner_id="user-a",trusted_user_confirmed="yes",
                proposal=self.proposal(),repository=FakeRepository())

if __name__=="__main__":
    unittest.main()
