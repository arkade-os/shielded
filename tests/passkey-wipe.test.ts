import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';

declare global {var __shieldedPasskeyFault:{prf:Uint8Array;stage:'mnemonic'|'master'};}
const sdk=import.meta.resolve('@arkade-os/sdk');
const mock=`export * from ${JSON.stringify(sdk)};
export async function createPrfPasskey(){return {credentialId:new Uint8Array([1]),prf:globalThis.__shieldedPasskeyFault.prf};}
export async function evaluatePrf(){return {...await createPrfPasskey(),userHandle:null};}
export function mnemonicFromPrf(){if(globalThis.__shieldedPasskeyFault.stage==='mnemonic')throw new Error('simulated mnemonic failure');return 'invalid recovery phrase';}`;
registerHooks({resolve:(specifier,context,next)=>specifier==='@arkade-os/sdk'?{url:`data:text/javascript,${encodeURIComponent(mock)}`,shortCircuit:true}:next(specifier,context)});
const {createPasskeySeed,restorePasskeySeed}=await import('../packages/protocol/src/passkey.ts');

test('seed derivation wipes its owned PRF bytes when either mnemonic or master derivation throws',async()=>{
 for(const derive of [createPasskeySeed,restorePasskeySeed])for(const stage of ['mnemonic','master'] as const){
  const prf=new Uint8Array(32).fill(7);globalThis.__shieldedPasskeyFault={prf,stage};
  await assert.rejects(derive({rpId:'shielded.mutinynet.arkade.sh',userName:'test wallet'}));
  assert.deepEqual(prf,new Uint8Array(32),`${derive.name}: ${stage} failure must wipe the returned SDK buffer`);
 }
});

test('bound-credential validation still wipes PRF before it can reach seed derivation',async()=>{
 const prf=new Uint8Array(32).fill(7);globalThis.__shieldedPasskeyFault={prf,stage:'mnemonic'};
 await assert.rejects(restorePasskeySeed({rpId:'shielded.mutinynet.arkade.sh',credentialId:Uint8Array.of(2),wordCount:12}),/does not match the recovery credential/);
 assert.deepEqual(prf,new Uint8Array(32));
});
