"""P2実DB検証: 原子性/ロールバック/並行/べき等性/所有者分離.

Requires SUPABASE_TEST_URL + SUPABASE_TEST_SERVICE_KEY pointing at a
DISPOSABLE test project. Never runs against the production ref
(dfvryaybdelgjxihdmth) and performs no writes unless both vars are set.
Without them every test SKIPS and the area stays 明示的に未検証 --
mock successes below must never be quoted as real-DB verification.
"""
import os
import unittest

TEST_URL = os.getenv("SUPABASE_TEST_URL", "")
TEST_KEY = os.getenv("SUPABASE_TEST_SERVICE_KEY", "")
PROD_REF = "dfvryaybdelgjxihdmth"

ENABLED = bool(TEST_URL and TEST_KEY and PROD_REF not in TEST_URL)


@unittest.skipUnless(ENABLED, "実DB未接続: SUPABASE_TEST_URL/KEY が未設定のため未検証")
class ProcurementLiveVerification(unittest.TestCase):
    def test_atomic_recipe_ledger_commit(self):
        self.fail("未実装: テストDBで一体commit→ recipe+ingredient+receipt の全件成功を確認")

    def test_rollback_on_ledger_conflict(self):
        self.fail("未実装: 既存ID指定で全件ロールバック（recipe revision不変）を確認")

    def test_concurrent_same_request_idempotency(self):
        self.fail("未実装: 同一request_id並行送付で単一commit＋片方replayを確認")

    def test_cross_owner_reference_rejected(self):
        self.fail("未実装: 他者 ingredient/offer/observation 参照の全経路拒否を確認")

    def test_receipt_replay_returns_canonical(self):
        self.fail("未実装: リプレイ時に正本revision＋空saved_idsを確認")


if __name__ == "__main__":
    unittest.main()
