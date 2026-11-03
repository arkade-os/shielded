import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {test} from 'node:test';
import {setImmediate as landed} from 'node:timers/promises';
import {promisify} from 'node:util';
import {x25519} from '@noble/curves/ed25519.js';
import {hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {parseViewKey} from '../packages/protocol/src/rollup/disclosure.ts';
import {parseRollupAddress} from '../packages/protocol/src/rollup/wallet.ts';
import {recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';
import {rollupDepositFeeFromEnv} from '../src/rollup/service.ts';
import {shieldedKeysOf} from '../src/shielded/wallet.ts';
import {feeKeeperTick,feeWalletKeysOf,type FeeKeeperWallet} from '../tools/shielded-fee-keeper.ts';

const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v))),phrase=recoveryPhraseOf('07'.repeat(32));
const DEAD='http://127.0.0.1:1';

/** Holds `held[asset]` notes; a merge takes two and leaves one once it settles, as the wallet's sync does. */
function stubWallet(held:Record<string,number>,fails:Record<string,'merge'|'settle'>={}){
 const asks:[bigint|undefined,number|undefined][]=[];let open=false,overlapped=false;
 const wallet:FeeKeeperWallet={
  merge:async(asset,above)=>{
   asks.push([asset,above]);overlapped||=open;
   if(open||asks.length>20)return undefined;
   const key=String(asset);
   if(fails[key]==='merge')throw new Error('refused '+key);
   if((held[key]??0)<2)return undefined;
   open=true;
   return {settled:async()=>{await landed();open=false;if(fails[key]==='settle')throw new Error('dropped '+key);held[key]=held[key]!-1;}};
  },
  shieldedNotes:asset=>Array.from({length:held[String(asset)]??0},()=>({amount:1n})),
  batchCount:()=>0,
 };
 return {wallet,asks,overlapped:()=>overlapped};
}
const run=(args:string[],env:Record<string,string>)=>promisify(execFile)(process.execPath,['--import','tsx','tools/shielded-fee-keeper.ts',...args],{timeout:60_000,env:{...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('SHIELDED_'))),...env}});
const refusal=async(args:string[],env:Record<string,string>)=>{
 const failed=await run(args,env).then(()=>undefined,error=>error as {code:number;stdout:string;stderr:string});
 assert.ok(failed,'the run should have been refused');
 assert.equal(failed.code,1);
 assert.ok(!(failed.stdout+failed.stderr).includes(phrase),'a refusal never repeats the phrase');
 return failed.stderr;
};

test('the keeper merges while more than one note is held and stops when one is left',async()=>{
 const four=stubWallet({0:4}),one=stubWallet({0:1}),none=stubWallet({});
 assert.deepEqual(await feeKeeperTick(four.wallet,[0n]),{merged:3,notes:1});
 assert.deepEqual(await feeKeeperTick(one.wallet,[0n]),{merged:0,notes:1});
 assert.deepEqual(await feeKeeperTick(none.wallet,[0n]),{merged:0,notes:0});
 assert.deepEqual(four.asks,[[0n,1],[0n,1],[0n,1],[0n,1]],'three merges, then the call that found nothing to merge');
 assert.equal(four.overlapped(),false,'each merge settles before the next is asked for');
});

test('each asset is merged down on its own, and the notes left are counted across all of them',async()=>{
 const {wallet,asks}=stubWallet({0:3,7:2,9:1});
 assert.deepEqual(await feeKeeperTick(wallet,[0n,7n,9n]),{merged:3,notes:3});
 assert.deepEqual(asks.map(([asset])=>asset),[0n,0n,0n,7n,7n,9n]);
 assert.ok(asks.every(([,above])=>above===1));
});

test('a merge that fails is logged and left for the next pass, and the other assets still merge',async t=>{
 const warn=t.mock.method(console,'error',()=>{});
 for(const fail of ['merge','settle'] as const){
  warn.mock.resetCalls();
  const {wallet}=stubWallet({0:3,7:3},{0:fail});
  assert.deepEqual(await feeKeeperTick(wallet,[0n,7n]),{merged:2,notes:4},fail);
  assert.equal(warn.mock.callCount(),1,fail);
  assert.match(warn.mock.calls[0]!.arguments.join(' '),/(refused|dropped) 0/,fail);
 }
});

test('each merge is reported as it lands, counted within the pass, and a merge that fails is not',async t=>{
 t.mock.method(console,'error',()=>{});
 const landed:number[]=[];
 await feeKeeperTick(stubWallet({0:4}).wallet,[0n],n=>landed.push(n));
 assert.deepEqual(landed,[1,2,3]);
 landed.length=0;
 await feeKeeperTick(stubWallet({0:3,7:3},{0:'settle'}).wallet,[0n,7n],n=>landed.push(n));
 assert.deepEqual(landed,[1,2],'the failed merge of asset 0 is skipped, and asset 7 lands two');
});

test('the derived address and view key are the pool\'s fee settings: they parse and name one wallet',()=>{
 const keys=feeWalletKeysOf(hash,phrase),to=parseRollupAddress(keys.address),view=parseViewKey(keys.viewKey),wallet=shieldedKeysOf(hash,phrase);
 assert.equal(view.owner,to.owner);
 assert.equal(hex.encode(x25519.getPublicKey(view.viewSecret)),hex.encode(to.viewPublic));
 assert.deepEqual(keys,{address:wallet.address,viewKey:wallet.viewKey});
});

test('--derive prints the pool settings for the phrase with no pool in reach, and never the phrase',async()=>{
 const {stdout,stderr}=await run(['--derive'],{SHIELDED_FEE_WALLET_PHRASE:phrase,SHIELDED_POOL_ORIGIN:DEAD});
 const printed=Object.fromEntries(stdout.trim().split(/\r?\n/).map(line=>line.split('=') as [string,string])),{address,viewKey}=feeWalletKeysOf(hash,phrase);
 assert.deepEqual(rollupDepositFeeFromEnv({...printed,SHIELDED_DEPOSIT_FEE_SATS:'100'}),{address,viewKey,fixedSats:100,bps:0});
 assert.ok(!(stdout+stderr).includes(phrase));
});

test('the keeper refuses to start without a phrase or with an interval that would spin, before it reaches for the pool',async()=>{
 assert.match(await refusal([],{SHIELDED_POOL_ORIGIN:DEAD}),/SHIELDED_FEE_WALLET_PHRASE/);
 for(const bad of ['abc','0',String(2**31)])
  assert.match(await refusal([],{SHIELDED_POOL_ORIGIN:DEAD,SHIELDED_FEE_WALLET_PHRASE:phrase,SHIELDED_FEE_KEEPER_INTERVAL_MS:bad}),/SHIELDED_FEE_KEEPER_INTERVAL_MS/,bad);
});

test('a phrase given as an argument is refused without being repeated',async()=>{
 for(const args of [['--derive',phrase],[phrase]])assert.match(await refusal(args,{SHIELDED_POOL_ORIGIN:DEAD}),/never from an argument/);
});
