# Stock Mutinynet acceptance

Only the fresh stock profile is eligible. Preserve the historical funded compact container, keys, image and volume. Development phase 2 is test-only; stock proof enforcement does not remove Groth16 setup assumptions or the public Arkade platform boundary.

## Funding and identities

Use the separate encrypted stock funding wallet. Bootstrap one exact customer VTXO into a 330-sat empty pool plus customer change. Persist the request before submission and accepted response before finalization. Every retry keeps the same outpoint, verifier, native policy, checkpoint, artifacts and journal identity. Unknown outcomes permit read-only reconciliation only.

The treasury wallet can act as the first test customer, with its keys outside the coordinator. Generate two additional independent client recovery secrets outside the coordinator. They can receive private notes and first withdraw at least 330 sats into their own normal Ark wallets; those payouts can fund their later sub-dust withdrawals. A 5,000-sat funding coin covers genesis and these zero-fee test flows without an additional faucet or a service-owned customer key.

## Required scenarios

- Empty genesis accepted by the public operator and indexer with the final immutable stock policy.
- First customer deposits its exact complete change VTXO; an unsealed note cannot be spent.
- Public seal works while the recipient is offline and requires no customer spending key.
- Private transfer to a second independently registered client; receiver recovers using only its secret and verified archive.
- A new third client joins after genesis has already been spent, then receives a private transfer.
- Normal withdrawal creates a spendable native customer Ark VTXO.
- One-sat withdrawal consumes an exact customer-owned dust-funding VTXO, with its signature and conservation checked.
- Full-note withdrawal does not append an unusable zero note.
- Changed native amounts, recipients, keys, proof, sidecar or release pins are rejected; stale parallel proofs do not reach submission.
- A disconnected client's exact accepted request is found in verified history without resubmission or later-coin selection.
- All test customers cash out and the pool retains only its 330-sat carrier.
- The same image, release artifacts, keys and encrypted Docker volume restart and reproduce the identical authenticated archive and head, followed by a fresh successful operation.

The operator archive and volume must contain no customer recovery, spend, view or native secret. Client secrets remain in ignored encrypted recovery storage. Publish only sanitized transaction identities, signed weights, step results and exact software/artifact pins after actual success.

## Evidence boundary

The local Service harness proves actual Groth16 and native policy execution on synthetic parents. It does not establish public ArkD admission, funded settlement, expiry renewal or platform-independent Bitcoin exits. Public acceptance and restart evidence are recorded separately. No step may bypass current network, fee, ancestry, signature or weight preflight; signed Ark transactions and all checkpoints must fit min(operator limit, 4000 WU).

The controlled three-party lifecycle uses the coordinator's durable sidecar archive. It does not establish recovery from a valid out-of-band transaction whose sender withholds that sidecar, or automatic adoption of a foreign native prepare.
