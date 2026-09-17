from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "bind-generated-runtime-contracts.py"
SPEC = importlib.util.spec_from_file_location("runtime_contract_binder", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("runtime_contract_binder_unavailable")
BINDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BINDER)


class RuntimeContractBinderTest(unittest.TestCase):
    def test_rebind_updates_refs_and_matching_repository_commit(self) -> None:
        old = "0" * 40
        core = "1" * 40
        smart = "2" * 40
        value = {
            "provenance": {
                "repository": "https://github.com/simai/ui-smart",
                "commit": old,
                "source_refs": [
                    f"simai/ui-smart@{old}:smart/table",
                    f"simai/ui@{old}:distr/rule/rule.json#name=cl-table",
                ],
            },
            "external": {
                "repository": "https://github.com/example/owner",
                "commit": old,
            },
        }

        rebound = BINDER.rebind(
            value,
            {"simai/ui": core, "simai/ui-smart": smart},
        )

        self.assertEqual(rebound["provenance"]["commit"], smart)
        self.assertEqual(
            rebound["provenance"]["source_refs"],
            [
                f"simai/ui-smart@{smart}:smart/table",
                f"simai/ui@{core}:distr/rule/rule.json#name=cl-table",
            ],
        )
        self.assertEqual(rebound["external"]["commit"], old)


if __name__ == "__main__":
    unittest.main()
