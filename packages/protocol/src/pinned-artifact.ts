import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface PinnedArtifact { size: number; sha256: string }
export type PinnedArtifactManifest = Record<string, PinnedArtifact>;

export async function verifyPinnedArtifact(response: Response, expected: PinnedArtifact, onProgress?: (loaded: number) => void): Promise<Uint8Array> {
  if (!response.ok || !Number.isSafeInteger(expected.size) || expected.size < 1 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Proving artifact unavailable or invalid pin');
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) !== expected.size)) throw new Error('Proving artifact size does not match its pin');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Proving artifact response has no body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expected.size) throw new Error('Proving artifact exceeds its pinned size');
      chunks.push(value);
      onProgress?.(size);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (size !== expected.size) throw new Error('Proving artifact size does not match its pin');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytesToHex(sha256(bytes)) !== expected.sha256) throw new Error('Proving artifact hash does not match its pin');
  return bytes;
}

export function createPinnedArtifactLoader(
  fetcher: typeof fetch,
  manifest: PinnedArtifactManifest,
  urlFor: (name: string) => string,
  headers?: HeadersInit,
  onProgress?: (name: string, loaded: number, total: number) => void,
): (name: string) => Promise<Uint8Array> {
  const cache = new Map<string, Promise<Uint8Array>>();
  return (name) => {
    const pin = manifest[name];
    if (!pin) return Promise.reject(new Error('Unknown pinned proving artifact'));
    const cached = cache.get(name);
    if (cached) return cached;
    let pending: Promise<Uint8Array>;
    pending = fetcher(urlFor(name), { headers })
      .then((response) => verifyPinnedArtifact(response, pin, onProgress && ((loaded) => onProgress(name, loaded, pin.size))))
      .catch((error) => {
        if (cache.get(name) === pending) cache.delete(name);
        throw error;
      });
    cache.set(name, pending);
    return pending;
  };
}
