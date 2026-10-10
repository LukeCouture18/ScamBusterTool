import os, tempfile, unittest
from siteinvestigator.db import Database, sid
from siteinvestigator.detectors import wallets, page_kind, indicators

class CoreTests(unittest.TestCase):
    def test_stable_typed_ids(self): self.assertTrue(sid("site").startswith("site_"))
    def test_wallet_context(self):
        x=wallets("Deposit USDT TRC20 to TY71QyjHvHCtXrJ8ZvRZqte4vbQ3zhKkNy")
        self.assertEqual(x[0]["network"],"TRON"); self.assertEqual(x[0]["token"],"USDT")
    def test_evm(self): self.assertEqual(wallets("ETH deposit 0x52908400098527886E0F7030069857D2E4169EE7")[0]["network"],"ETHEREUM")
    def test_kind(self): self.assertEqual(page_kind("https://x.test/account/deposit","fund wallet"),"deposit")
    def test_indicators(self): self.assertIn("help@example.com",indicators("help@example.com","<p>help@example.com</p>")["emails"])
    def test_database(self):
        with tempfile.TemporaryDirectory() as d:
            db=Database(d); self.assertTrue(db.path.exists())

if __name__=="__main__": unittest.main()
