from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class DeploymentGuardTests(unittest.TestCase):
    def test_pairing_adapter_remains_fail_closed(self):
        source = (ROOT / "contracts/pairing_product.ark").read_text()
        self.assertIn('require(false, "experimental verifier disabled")', source)

    def test_no_admin_tapscript_in_shared_resources(self):
        for entry in ("lane", "btc_vault", "asset_vault"):
            source = (ROOT / "contracts" / (entry + ".ark")).read_text()
            self.assertNotIn(") tapscript", source)

if __name__ == "__main__":
    unittest.main()
