import {randomBytes} from 'node:crypto';
import {blake2b} from '@noble/hashes/blake2.js';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import * as snarkjs from 'snarkjs';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(path.join(root, 'build'), {recursive: true});
const scratch = mkdtempSync(path.join(root, 'build', 'plonk-comparison-'));
const compilerPath = path.join(root, 'node_modules/circom2/cli.js');
const compilerVersionRun = spawnSync(process.execPath, [compilerPath, '--version'], {encoding: 'utf8'});
if (compilerVersionRun.status !== 0) throw new Error('could not identify Circom compiler version');
const compilerVersion = (compilerVersionRun.stdout || compilerVersionRun.stderr).match(/circom compiler\s+([^\s]+)/i)?.[1];
if (!compilerVersion) throw new Error('Circom compiler version was not reported');
const snarkjsVersion = JSON.parse(readFileSync(path.join(root, 'node_modules/snarkjs/package.json'), 'utf8')).version;
const source = 'pragma circom 2.1.6; template Tiny(){ signal input a; signal input b; signal output c; c <== a*b; } component main { public [a] } = Tiny();';
writeFileSync(path.join(scratch, 'tiny.circom'), source);
const compile = spawnSync(process.execPath, [compilerPath, 'tiny.circom', '--r1cs', '--wasm', '--sym', '--O2', '-o', '.'], {cwd: scratch, encoding: 'utf8'});
if (compile.status !== 0) throw new Error(`tiny circuit compilation failed: ${compile.stderr || compile.stdout}`);
const r1cs = path.join(scratch, 'tiny.r1cs');
const wasm = path.join(scratch, 'tiny_js/tiny.wasm');
const input = {a: '3', b: '5'};
const ceremonyUrl = 'https://circom.info/powersOfTau28_hez_final_08.ptau';
const expectedCeremonyHash = 'd6a8fb3a04feb600096c3b791f936a578c4e664d262e4aa24beed1b7a9a96aa5eb72864d628db247e9293384b74b36ffb52ca8d148d6e1b8b51e279fdf57b583';
const response = await fetch(ceremonyUrl, {signal: AbortSignal.timeout(30_000)});
if (!response.ok || !response.body) throw new Error(`public Powers of Tau download failed: HTTP ${response.status}`);
const reader = response.body.getReader();
const chunks = [];
let downloadedBytes = 0;
while (true) {
  const {value, done} = await reader.read();
  if (done) break;
  downloadedBytes += value.byteLength;
  if (downloadedBytes > 2 * 1024 * 1024) {
    await reader.cancel();
    throw new Error('public Powers of Tau exceeds the 2 MiB download cap');
  }
  chunks.push(Buffer.from(value));
}
const ceremonyBytes = Buffer.concat(chunks);
const ceremonyHash = Buffer.from(blake2b(ceremonyBytes, {dkLen: 64})).toString('hex');
if (ceremonyHash !== expectedCeremonyHash) throw new Error(`public Powers of Tau BLAKE2b-512 mismatch: ${ceremonyHash}`);
const ceremonyHashPinned = ceremonyHash === expectedCeremonyHash;
const publicPtau = path.join(scratch, 'public-powersoftau.ptau');
writeFileSync(publicPtau, ceremonyBytes);

const g16ZkeyInitial = path.join(scratch, 'tiny-groth16-initial.zkey');
const g16Zkey = path.join(scratch, 'tiny-groth16.zkey');
const plonkZkey = path.join(scratch, 'tiny-plonk.zkey');
await snarkjs.zKey.newZKey(r1cs, publicPtau, g16ZkeyInitial);
await snarkjs.zKey.contribute(g16ZkeyInitial, g16Zkey, 'isolated local benchmark', randomBytes(64).toString('hex'));
await snarkjs.plonk.setup(r1cs, publicPtau, plonkZkey);

const measure = async (fn) => {
  const start = performance.now();
  const value = await fn();
  return {value, ms: performance.now() - start};
};
const g16ProofResult = await measure(() => snarkjs.groth16.fullProve(input, wasm, g16Zkey));
const plonkProofResult = await measure(() => snarkjs.plonk.fullProve(input, wasm, plonkZkey));
const g16Vk = await snarkjs.zKey.exportVerificationKey(g16Zkey);
const plonkVk = await snarkjs.zKey.exportVerificationKey(plonkZkey);
const rejected = async (fn) => {
  try { return (await fn()) !== true; } catch { return true; }
};
const verifyCase = async (verify, vk, result, commitmentName) => {
  const {proof, publicSignals} = result;
  const valid = await measure(() => verify(vk, publicSignals, proof));
  const changedSignals = [...publicSignals];
  changedSignals[changedSignals.length - 1] = (BigInt(changedSignals.at(-1)) + 1n).toString();
  const changedPublicRejected = await rejected(() => verify(vk, changedSignals, proof));
  const changedProof = structuredClone(proof);
  const replacementName = commitmentName === 'pi_a' ? 'pi_c' : 'B';
  changedProof[commitmentName] = structuredClone(proof[replacementName]);
  const changedProofRejected = await rejected(() => verify(vk, publicSignals, changedProof));
  return {valid: valid.value, verifyMs: valid.ms, changedPublicRejected, changedProofRejected};
};
const g16Checks = await verifyCase(snarkjs.groth16.verify, g16Vk, g16ProofResult.value, 'pi_a');
const plonkChecks = await verifyCase(snarkjs.plonk.verify, plonkVk, plonkProofResult.value, 'A');
if (!g16Checks.valid || !plonkChecks.valid || !g16Checks.changedPublicRejected || !plonkChecks.changedPublicRejected || !g16Checks.changedProofRejected || !plonkChecks.changedProofRejected) {
  throw new Error('proof acceptance/rejection check failed');
}
const wordCount = (callData) => (callData.match(/0x[0-9a-f]{64}/gi) || []).length;
const g16CallData = await snarkjs.groth16.exportSolidityCallData(g16ProofResult.value.proof, g16ProofResult.value.publicSignals);
const plonkCallData = await snarkjs.plonk.exportSolidityCallData(plonkProofResult.value.proof, plonkProofResult.value.publicSignals);
const g16CallDataWords = wordCount(g16CallData);
const plonkCallDataWords = wordCount(plonkCallData);
const g16ProofFieldWords = g16CallDataWords - g16ProofResult.value.publicSignals.length;
const plonkProofFieldWords = plonkCallDataWords - plonkProofResult.value.publicSignals.length;
if (g16ProofFieldWords !== 8 || plonkProofFieldWords !== 24) throw new Error('unexpected Solidity call-data layout');

const g16ProofRawBytes = g16ProofFieldWords * 32;
const plonkProofRawBytes = plonkProofFieldWords * 32;
const g16VkRawBytes = 64 + 3 * 128 + (g16Vk.nPublic + 1) * 64;
const plonkVkRawBytes = 8 * 64 + 128 + 3 * 32;
const plonkVkMinimumBytes = 8 * 64 + 128 + 2 * 32;
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const readCurrentGroth16 = (name) => {
  const file = path.join(root, 'circuits/build', `${name}.vkey.json`);
  const vk = JSON.parse(readFileSync(file, 'utf8'));
  return {
    publicSignals: vk.nPublic,
    verificationKeyJsonBytes: statSync(file).size,
    verifierKeyCryptoBytes: 64 + 3 * 128 + vk.IC.length * 64
  };
};
const currentGroth16 = {
  intent: readCurrentGroth16('intent'),
  transition: readCurrentGroth16('transition')
};
const g16CompressedEstimate = 2 * 32 + 64;
const plonkCompressedEstimate = 9 * 32 + 6 * 32;
const json = {
  experiment: 'isolated tiny arithmetic circuit; not a Shielded intent or transition proof',
  tools: {snarkjs: snarkjsVersion, circomCompiler: compilerVersion, curve: 'bn128'},
  verificationNote: 'full snarkjs Powers of Tau transcript verification was not run: its genesis-challenge routine uses ceremonyPower 2^28 even for this power-8 truncated file',
  circuit: {relation: 'public a, private b, public c; c = a*b', nonlinearConstraints: 1, linearConstraints: 0, statement: {a: '3', b: '5', c: '15'}, powersOfTau: 8, setup: 'published phase-2-ready ceremony with 54 contributions and a beacon; Groth16 zkey gets one local development contribution'},
  reusablePowersOfTau: {url: ceremonyUrl, hashAlgorithm: 'BLAKE2b-512', hash: ceremonyHash, bytes: downloadedBytes, publishedContributions: 54, publishedBeacon: true, checksumMatchesPublishedFile: ceremonyHashPinned, fullTranscriptReverifiedBySnarkjs: false},
  results: {
    groth16: {proofComponents: 3, solidityProofWords: g16ProofFieldWords, proofJsonBytes: jsonBytes(g16ProofResult.value.proof), proofCryptoBytes: g16ProofRawBytes, compressedPointProjectionBytes: g16CompressedEstimate, publicSignals: g16ProofResult.value.publicSignals.length, publicSignalBytes: 32 * g16ProofResult.value.publicSignals.length, verificationKeyJsonBytes: jsonBytes(g16Vk), verificationKeyCryptoBytes: g16VkRawBytes, proveMs: g16ProofResult.ms, verifyMs: g16Checks.verifyMs, validAccepted: g16Checks.valid, changedPublicRejected: g16Checks.changedPublicRejected, changedProofRejected: g16Checks.changedProofRejected, alteredProofMethod: 'replace pi_a with another valid proof G1 point'},
    plonk: {proofComponents: 9, evaluationScalars: 6, solidityProofWords: plonkProofFieldWords, proofJsonBytes: jsonBytes(plonkProofResult.value.proof), proofCryptoBytes: plonkProofRawBytes, compressedPointProjectionBytes: plonkCompressedEstimate, publicSignals: plonkProofResult.value.publicSignals.length, publicSignalBytes: 32 * plonkProofResult.value.publicSignals.length, verificationKeyJsonBytes: jsonBytes(plonkVk), verificationKeyCryptoBytesIncludingDerivedRootOfUnity: plonkVkRawBytes, minimumVerificationKeyCryptoBytesDerivingRootOfUnity: plonkVkMinimumBytes, proveMs: plonkProofResult.ms, verifyMs: plonkChecks.verifyMs, validAccepted: plonkChecks.valid, changedPublicRejected: plonkChecks.changedPublicRejected, changedProofRejected: plonkChecks.changedProofRejected, alteredProofMethod: 'replace A with another valid proof G1 point'},
    currentShieldedGroth16: {
      intent: readCurrentGroth16('intent'),
      transition: readCurrentGroth16('transition')
    },
    currentShieldedCombined: {
      logicalPublicSignals: currentGroth16.intent.publicSignals + currentGroth16.transition.publicSignals,
      logicalPublicSignalBytesNotDeduplicatedAgainstNativeWire: 32 * (currentGroth16.intent.publicSignals + currentGroth16.transition.publicSignals),
      groth16ProofCryptoBytesTwoCircuits: 2 * g16ProofRawBytes,
      groth16VerifierKeyCryptoBytes: currentGroth16.intent.verifierKeyCryptoBytes + currentGroth16.transition.verifierKeyCryptoBytes,
      hypotheticalTwoPlonkProofCryptoBytes: 2 * plonkProofRawBytes,
      hypotheticalTwoPlonkCompressedPointProjectionBytes: 2 * plonkCompressedEstimate,
      hypotheticalTwoPlonkVerifierKeyCryptoBytesIncludingDerivedRootOfUnity: 2 * plonkVkRawBytes,
      hypotheticalTwoPlonkVerifierKeyMinimumCryptoBytesDerivingRootOfUnity: 2 * plonkVkMinimumBytes,
      groth16ProofPlusKeyPayloadBytesTwoCircuits: 2 * g16ProofRawBytes + currentGroth16.intent.verifierKeyCryptoBytes + currentGroth16.transition.verifierKeyCryptoBytes,
      hypotheticalPlonkProofPlusMinimumKeyPayloadBytesTwoCircuits: 2 * plonkProofRawBytes + 2 * plonkVkMinimumBytes,
      hypotheticalPlonkProofPlusKeyWithRootOfUnityBytesTwoCircuits: 2 * plonkProofRawBytes + 2 * plonkVkRawBytes,
      hypotheticalTwoPlonkProofNonWitnessWeightLowerBoundWU: 2 * plonkProofRawBytes * 4
    }
  },
  measurementLimits: ['timings are single local tiny-circuit JavaScript measurements, not EVM gas or Ark emulator WU', 'proof byte counts come from snarkjs Solidity calldata word layout; public signals are reported separately', 'compressed sizes are point-compression projections, not an implemented codec; verifier-side decompression is unmeasured', 'existing Shielded Groth16 sizes are read from checked-in development verification keys; no Shielded PLONK setup or proof was generated', '55 logical public signals are not the native publicData packet: values overlap and native wire deduplication/serialization was not measured', 'proof plus verifier-key comparisons exclude logical signals, any reused circuit setup, transaction framing, and native wire data', 'weight lower bound is two PLONK proof payloads at 4 WU per non-witness byte; excludes public signals, binding, and transaction framing', 'binary sizes exclude transaction framing and any app-specific envelope']
};
const target = path.join(root, 'validation/plonk-comparison.json');
writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`);
const resolvedScratch = path.resolve(scratch);
const resolvedBuild = path.resolve(root, 'build');
if (path.dirname(resolvedScratch) !== resolvedBuild || !path.basename(resolvedScratch).startsWith('plonk-comparison-')) throw new Error('refusing to remove scratch outside the experiment build directory');
rmSync(resolvedScratch, {recursive: true, force: true});
console.log(JSON.stringify(json, null, 2));
process.exit(0);
