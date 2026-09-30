#!/usr/bin/env python3
"""Compile the non-deployable source scaffold; never remove the rejection guard."""
from pathlib import Path
import argparse
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINTS = ("lane", "btc_vault", "asset_vault", "batch_verifier")

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", required=True, help="Path to a trusted arkadec binary")
    args = parser.parse_args()
    compiler = str(Path(args.compiler).resolve())
    guard = (ROOT / "contracts/pairing_product.ark").read_text()
    if 'require(false, "experimental verifier disabled")' not in guard:
        raise SystemExit("Refusing scaffold check: unconditional deployment guard was changed")
    output = ROOT / "build"
    output.mkdir(exist_ok=True)
    report = []
    for entry in ENTRYPOINTS:
        for optimize in (False, True):
            path = output / f"{entry}.{'optimized' if optimize else 'raw'}.json"
            command = [compiler, str(ROOT / "contracts" / (entry + ".ark")), "-o", str(path)]
            if not optimize:
                command.append("--no-optimize")
            subprocess.run(command, check=True)
            artifact = json.loads(path.read_text())
            groups = [f["name"] for f in artifact["functions"]]
            if entry == "batch_verifier" and set(groups) != {"apply", "seal"}:
                raise SystemExit("Unexpected verifier spending paths")
            report.append({"entry": entry, "optimized": optimize, "groups": groups,
                           "fingerprint": artifact.get("fingerprint")})
    (output / "compile-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Compiled 8 artifacts. Deployment remains disabled; no VM or ZK tests performed.")

if __name__ == "__main__":
    main()
