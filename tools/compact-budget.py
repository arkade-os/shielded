#!/usr/bin/env python3
"""Size illustrative publication envelopes; no proof verification or broadcast."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSV_COUNTS = (1, 2, 4, 8, 16, 64)
BRIDGE_BYTES = 32 * 4 + 256
P2TR_KEY = bytes.fromhex("79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")


def compact_size(value: int) -> bytes:
    if value < 0:
        raise ValueError("CompactSize cannot encode a negative integer")
    if value < 253:
        return bytes((value,))
    if value <= 0xFFFF:
        return b"\xfd" + struct.pack("<H", value)
    if value <= 0xFFFFFFFF:
        return b"\xfe" + struct.pack("<I", value)
    return b"\xff" + struct.pack("<Q", value)


def push_data(data: bytes) -> bytes:
    size = len(data)
    if size <= 75:
        return bytes((size,)) + data
    if size <= 0xFF:
        return b"\x4c" + bytes((size,)) + data
    if size <= 0xFFFF:
        return b"\x4d" + struct.pack("<H", size) + data
    return b"\x4e" + struct.pack("<I", size) + data


def op_return_script(data: bytes) -> bytes:
    return b"\x6a" + push_data(data)


def csv_payload(count: int) -> bytes:
    return b"SCV1" + b"\x01" + compact_size(count) + bytes(64 * count + 64)


def bridge_payload() -> bytes:
    return bytes(BRIDGE_BYTES)


def witness_script(chunk_count: int) -> bytes:
    return b"\x20" + P2TR_KEY + b"\xad" + b"\x75" * chunk_count + b"\x51"


def split_chunks(data: bytes, maximum: int = 520) -> list[bytes]:
    return [data[i : i + maximum] for i in range(0, len(data), maximum)]


def transaction(payload: bytes, carrier: str) -> tuple[bytes, int, int]:
    tx_input = bytes(32) + struct.pack("<I", 0) + b"\x00" + struct.pack("<I", 0xFFFFFFFD)
    change_script = b"\x51\x20" + P2TR_KEY
    change = struct.pack("<Q", 999_000) + compact_size(len(change_script)) + change_script
    if carrier == "op_return":
        data_script = op_return_script(payload)
        data_output = struct.pack("<Q", 0) + compact_size(len(data_script)) + data_script
        witnesses = [bytes(64)]
    elif carrier == "witness":
        data_script = op_return_script(b"")
        data_output = struct.pack("<Q", 0) + compact_size(len(data_script)) + data_script
        chunks = split_chunks(payload)
        script = witness_script(len(chunks))
        control_block = b"\xc0" + P2TR_KEY
        witnesses = [*chunks, bytes(64), script, control_block]
    else:
        raise ValueError(f"Unknown carrier: {carrier}")

    version = struct.pack("<I", 2)
    inputs = compact_size(1) + tx_input
    outputs = compact_size(2) + data_output + change
    lock_time = struct.pack("<I", 0)
    stripped = version + inputs + outputs + lock_time
    witness_data = compact_size(len(witnesses)) + b"".join(
        compact_size(len(item)) + item for item in witnesses
    )
    full = version + b"\x00\x01" + inputs + outputs + witness_data + lock_time
    return full, len(stripped), len(full) - len(stripped)


def estimate(payload: bytes, carrier: str, budget_wu: int) -> dict[str, int | bool | str]:
    raw, base_bytes, witness_bytes = transaction(payload, carrier)
    weight = 4 * base_bytes + witness_bytes
    return {
        "carrier": carrier,
        "payloadBytes": len(payload),
        "baseBytes": base_bytes,
        "witnessBytes": witness_bytes,
        "fullBytes": len(raw),
        "weightUnits": weight,
        "virtualBytes": math.ceil(weight / 4),
        "passesIllustrativeTransactionBudget": weight <= budget_wu,
        "serializedTxSha256": hashlib.sha256(raw).hexdigest(),
    }


def current_measurements() -> dict[str, object]:
    path = ROOT / "validation" / "e2e.json"
    fixture = json.loads(path.read_text(encoding="utf-8"))
    by_action: dict[str, list[int]] = {}
    for receipt in fixture["receipts"]:
        result = receipt.get("result", {})
        native = result.get("native", {})
        if receipt.get("action") and native.get("estimatedSignedWeight") is not None:
            by_action.setdefault(receipt["action"], []).append(native["estimatedSignedWeight"])
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    cap = re.search(r"currently permits ([\d,]+) weight units", readme)
    floor = re.search(r"floor of ([\d,]+)", readme)
    return {
        "source": "validation/e2e.json (emulator fixture; not live chain settlement)",
        "operatorCapFromReadmeWu": int(cap.group(1).replace(",", "")) if cap else None,
        "profileFloorFromReadmeWu": int(floor.group(1).replace(",", "")) if floor else None,
        "maxObservedSignedWeightWuByAction": {name: max(values) for name, values in sorted(by_action.items())},
    }


def build(budget_wu: int) -> dict[str, object]:
    csv_rows = []
    for count in CSV_COUNTS:
        payload = csv_payload(count)
        expected = 70 + 64 * count
        assert len(payload) == expected
        csv_rows.append({
            "records": count,
            "payloadBytes": len(payload),
            "opReturn": estimate(payload, "op_return", budget_wu),
            "witnessCarrier": estimate(payload, "witness", budget_wu),
        })

    bridge = bridge_payload()
    assert len(bridge) == 384
    bridge_rows = {
        carrier: estimate(bridge, carrier, budget_wu)
        for carrier in ("op_return", "witness")
    }
    for row in [item[key] for item in csv_rows for key in ("opReturn", "witnessCarrier")] + list(bridge_rows.values()):
        assert row["weightUnits"] == 4 * row["baseBytes"] + row["witnessBytes"]
        assert row["fullBytes"] == row["baseBytes"] + row["witnessBytes"]
        assert row["virtualBytes"] == math.ceil(row["weightUnits"] / 4)
    for key in ("opReturn", "witnessCarrier"):
        assert all(
            csv_rows[i][key]["weightUnits"] < csv_rows[i + 1][key]["weightUnits"]
            for i in range(len(csv_rows) - 1)
        )

    return {
        "metadata": {
            "kind": "illustrative-sizing-only",
            "proofVerified": False,
            "transactionSigned": False,
            "broadcast": False,
            "cryptographicVerifierImplemented": False,
            "budgetWu": budget_wu,
            "budgetScope": "Standalone transaction serialization only; excludes Arkade program execution, bytecode outside the modeled carrier, fee-rate policy, and operator admission rules.",
            "relayPolicy": "Not evaluated; successful serialization does not imply standard relay or operator acceptance.",
            "transactionShape": "one 1,000,000-sat P2TR input, zero-value data output, 999,000-sat P2TR change, 1,000-sat illustrative fee",
            "opReturnAssumption": "The payload is in the transaction output script and therefore counted as base bytes at 4 WU/byte.",
            "witnessCarrierAssumption": "Hypothetical P2TR script-path input; payload is split into <=520-byte witness items and dropped by a tapscript that checks a 64-byte placeholder signature. Adds 33-byte placeholder control block, script, stack/item CompactSize prefixes, and 2 marker/flag bytes. The placeholder control block/signature are not valid; no Arkade carrier support is claimed.",
            "csvTransportAssumption": "SCV1 magic (4 B), version (1 B), CompactSize record count, N records of (Pk32,R32), aggregate scalar (32 B), publisher-address commitment (32 B). This models transport bytes only; no Sign-to-contract, half-aggregation, or PCD is implemented.",
            "compactBridgeAssumption": "Fixed 384 B envelope: old root32 + new root32 + effect digest32 + VK profile ID32 + Groth16 proof256. No cryptographic verifier is implemented; 1,536 WU is only its OP_RETURN payload increment, before transaction framing, signatures, and program costs.",
        },
        "currentDesign": current_measurements(),
        "csvPublication": csv_rows,
        "compactBridge384Bytes": {
            "payloadBytes": len(bridge),
            "opReturnPayloadIncrementWu": 4 * len(bridge),
            "witnessPayloadIncrementWu": len(bridge),
            "transactions": bridge_rows,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--budget-wu", type=int, default=4000)
    parser.add_argument("--output", type=Path, default=ROOT / "validation" / "compact-budget.json")
    args = parser.parse_args()
    if args.budget_wu <= 0:
        parser.error("--budget-wu must be positive")
    output = build(args.budget_wu)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}; {len(CSV_COUNTS)} CSV sizes, 384-byte bridge, {args.budget_wu} WU budget")


if __name__ == "__main__":
    main()
