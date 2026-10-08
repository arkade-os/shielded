# Security status

Shielded is unaudited research software for Mutinynet test coins. Do not use it with real funds.

- **Trusted setup.** The proving keys come from a development-only setup that the server runs for itself. Whoever controls that setup could forge proofs. There is no ceremony.
- **Who enforces the rules.** The pool covenant verifies every client proof and the batch proof through the Arkade emulator's opcodes, and the Arkade operator co-signs. Bitcoin itself does not check the proofs. Both services must stay honest and online; there is no independent exit from the pool if they do not.
- **The pool operator** orders spends into batches and stores the encrypted note records. It can delay or refuse a spend, but it cannot spend a note without a proof that only the note owner's keys can make.
- **If the operator stops or refuses you,** the batch leaf still accepts any valid batch. With the published batch key, `tools/rollup-fallback.ts` proves one from your own spend and submits it to Arkade directly. That needs a mirror of the pool's records and keys, made while the operator was up (the batch key is 305 MB). Other wallets, and the operator itself, follow such a batch only once its record is handed over (`publish`). Until then, the notes it creates cannot be found. Renewing the head needs the operator, so without it the head expires at most a week after its last renewal, and every payout made from it expires at the same time. Withdraw, and move the payout on Arkade, before then.
- **Recovery** needs the published records and the wallet's recovery secret. Nobody can reset a lost secret.
- **Privacy.** Deposits and withdrawals are public, including amounts and the Arkade addresses involved. Payments inside the pool hide sender, recipient and amount, and the anonymity set is the pool's other users.

Report issues privately to the maintainers. Do not post private details in public dependency issues or PRs.
