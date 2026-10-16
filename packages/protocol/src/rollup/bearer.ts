import { bech32m } from '@scure/base';

const PREFIX = 'shnote2', VERSION = 0;
/** A claim link: the bearer key's seed, and the batch its notes landed in, where a claimer starts reading. */
export interface ClaimToken { secret: Uint8Array; batch: number }

export function encodeClaimToken({ secret, batch }: ClaimToken): string {
 if (secret.length !== 32) throw new Error('A claim token holds a 32-byte seed.');
 if (!Number.isInteger(batch) || batch < 0 || batch > 0xffffffff) throw new Error('A claim token holds a batch number.');
 const bytes = new Uint8Array(37);
 bytes[0] = VERSION;
 bytes.set(secret, 1);
 new DataView(bytes.buffer).setUint32(33, batch);
 return bech32m.encode(PREFIX, bech32m.toWords(bytes), false);
}
export function decodeClaimToken(token: string): ClaimToken {
 let prefix: string, bytes: Uint8Array;
 try { const decoded = bech32m.decode(token.trim() as `${string}1${string}`, false); prefix = decoded.prefix; bytes = bech32m.fromWords(decoded.words); } catch { throw new Error('Not a claim link.'); }
 if (prefix !== PREFIX || bytes.length !== 37) throw new Error('Not a claim link.');
 if (bytes[0] !== VERSION) throw new Error(`This claim link is version ${bytes[0]}; this wallet reads version ${VERSION}.`);
 return { secret: bytes.slice(1, 33), batch: new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(33) };
}
