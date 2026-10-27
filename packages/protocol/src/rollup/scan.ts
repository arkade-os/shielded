/** The low 32 bits of a nullifier: a match only means the batch is fetched whole and checked there. */
export const nullifierHint = (nullifier: bigint) => Number(nullifier & 0xffffffffn);
