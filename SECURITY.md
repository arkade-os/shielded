# Security status

Shielded is unaudited research software for Mutinynet test coins. Do not use it with real funds.

- **Trusted setup.** The proving keys come from a development-only setup that the server runs for itself. Whoever controls that setup could forge proofs. There is no ceremony.
- **Who enforces the rules.** The pool covenant verifies every client proof and the batch proof through the Arkade emulator's opcodes, and the Arkade operator co-signs. Bitcoin itself does not check the proofs. Both services must stay honest and online; there is no independent exit from the pool if they do not.
- **The pool operator** orders spends into batches and stores the encrypted note records. It can delay or refuse a spend, but it cannot spend a note without a proof that only the note owner's keys can make.
- **Recovery** needs the published records and the wallet's recovery secret. Nobody can reset a lost secret.
- **Privacy.** Deposits and withdrawals are public, including amounts and the Arkade addresses involved. Payments inside the pool hide sender, recipient and amount, and the anonymity set is the pool's other users.

Report issues privately to the maintainers. Do not post private details in public dependency issues or PRs.
