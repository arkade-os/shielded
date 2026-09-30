import assert from 'node:assert/strict';
import { createProtocol } from '../packages/protocol/src/index.js';
const kernel=await createProtocol();
const results:unknown[]=[];
async function apply(prepared:Awaited<ReturnType<typeof kernel.prepareSeal>>){
 assert.equal(await kernel.verify(prepared),true);
 results.push({operation:prepared.operation,proofTimes:prepared.proofTimes,noteRoot:prepared.newState.noteRoot});
 await kernel.commit(prepared,{kind:'primitive-smoke',id:prepared.id});
}
await apply(await kernel.prepareShield('alice','BTC',10_000));
await apply(await kernel.prepareShield('alice','DEMO',1_000));
assert.equal(kernel.snapshot().wallets.alice.pending.BTC,10_000);
await assert.rejects(()=>kernel.prepareTransfer('alice','bob','BTC',2_500),/No sealed/);
await apply(await kernel.prepareSeal());
const pending=await kernel.prepareTransfer('alice','bob','BTC',2_500);
const staleRoots=pending.transitionSignals.slice();
// Competing append changes public state but does not consume pending intent's note.
await apply(await kernel.prepareShield('bob','DEMO',1));
await assert.rejects(()=>kernel.commit(pending,{}),/Stale settlement/);
const rebased=await kernel.rebase(pending);
assert.deepEqual(rebased.intentProof,pending.intentProof);
assert.deepEqual(rebased.intentSignals,pending.intentSignals);
assert.notDeepEqual(rebased.transitionSignals,staleRoots);
await apply(rebased);
await assert.rejects(()=>kernel.rebase(rebased),/already spent/);
await apply(await kernel.prepareSeal());
assert.equal(kernel.snapshot().wallets.bob.balances.BTC,2_500);
const withdrawal=await kernel.prepareWithdraw('bob','BTC',500,'11'.repeat(32));
const substituted=structuredClone(withdrawal);substituted.intentSignals[23]=(BigInt(substituted.intentSignals[23])+1n).toString();
assert.equal(await kernel.verify(substituted),false,'A destination substitution must invalidate private authorization.');
const corruptCipher=structuredClone(withdrawal);corruptCipher.intentSignals[7]=(BigInt(corruptCipher.intentSignals[7])+1n).toString();corruptCipher.transitionSignals[7]=corruptCipher.intentSignals[7];
assert.equal(await kernel.verify(corruptCipher),false,'A ciphertext mutation must invalidate proof binding.');
await apply(withdrawal);
assert.equal(kernel.snapshot().state.reserves.BTC,9_500);
assert.equal(kernel.recover('bob').filter(n=>!n.spent).reduce((s,n)=>s+(n.asset==='BTC'?n.amount:0),0),2_000);
console.log(JSON.stringify({passed:true,steps:results,state:kernel.snapshot().state},null,2));
process.exit(0);
