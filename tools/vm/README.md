# Actual Arkade VM bridge

The app passes its SDK-built Ark transaction and checkpoint PSBTs to the
upstream `emulator.Service.SubmitTx`. The bridge uses the actual Go VM,
checkpoint validation, Taproot commitment checks, default per-input and
request compute budgets, and emulator cosigning. There is no JavaScript VM
substitute and no always-accept proof check.

Before any signing, the bridge also invokes the actual Ark native asset
validator with allocations recovered from each original transaction's
authenticated output. It rejects fabricated input allocations, omitted assets,
issuance or reissuance during settlement, burns, duplicate source VTXOs, and
native BTC overspending. Original output indices come from checkpoint inputs;
an Ark transaction's checkpoint output index is always zero and cannot be
used to look up the original output's assets.

The local demo supplies synthetic genesis resources. This bridge checks their
transaction and checkpoint consistency; it does not consult a live arkd
indexer to establish canonical acceptance, finality, or current unspent status.
The app's local ledger supplies that boundary for the showcase. A funded
deployment must obtain canonical resources from arkd and use its real operator
and emulator signing services.

## Build and run

Requires Go 1.26.6 or newer. Dependencies are pinned in `go.mod` and `go.sum`.

```sh
cd tools/vm
go test ./...
go build -o ../../bin/shielded-vm .
../../bin/shielded-vm --info
../../bin/shielded-vm --listen 127.0.0.1:8788
```

The HTTP server listens only on loopback. Without `--listen`, it reads one JSON
request per stdin line and writes one JSON response per stdout line. `/health`
returns the runtime profile. `POST /execute` accepts:

```json
{
  "id": "optional-request-id",
  "arkTx": "base64 PSBT",
  "checkpoints": ["base64 PSBT"],
  "vtxoExpiries": [{"txid": "hex transaction ID", "vout": 0, "expiry": 0}]
}
```

`vtxoExpiries` is optional and is needed only for scripts using `OP_PUSHEXPIRY`.
The Ark PSBT must include its SDK `PrevArkTxField` for every input. Each
checkpoint must spend the actual corresponding original VTXO and carry the
correct SDK native Taproot paths.

On success the response includes `ok: true`, signed `arkTx` and `checkpoints`,
`txid`, `executedInputs`, `signatureCount`, `durationMs`, and `backend`. On
failure it includes `ok: false` and `error`; it never returns partially signed
PSBTs from a failed request. The upstream service mutates request objects, so
every bridge invocation reparses fresh PSBTs.

For a failed JSONL request, `--trace` writes a local diagnostic replay to stderr.
It reports the failing instruction's ordinal and byte offset plus the last
stack snapshots, using the same original prevout mapping, expiry data, and
default compute budgets. The authoritative signing result still comes from
`Service.SubmitTx`; a diagnostic replay never signs or changes acceptance.
Trace output may contain witness data, so keep it with local debugging files.

## Public PoC keys

The embedded emulator private key is 32 repetitions of byte `02`; the server
key is 32 repetitions of byte `01`. These are deliberately reproducible
fixtures. **Never fund programs using these keys.** All submitted emulator
entries must belong to this PoC emulator; foreign-signing inputs fail closed.

## Tests

`go test` exercises genuine native transfers, original output indices beyond
zero, fabricated reserve quantities, omitted assets, substituted identities,
settlement issuance/reissuance, burns, invalid extension payouts, BTC
overspending, negative output values, substituted or missing original
transactions, and malformed request envelopes. The app's end-to-end tests
exercise the compiled Program, real Groth16 proofs, SDK transaction builder,
and this signing path together.
