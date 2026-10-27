import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ARCHIVE_DEPTH,EPOCH_NULLIFIER_DEPTH,EPOCH_SLOTS,RECOVERED_DEPTH} from '../packages/protocol/src/rollup/constants.ts';
import {decodeDisclosure,fullViewKeyOf,parseFullViewKey,parseViewKey,viewKeyOf} from '../packages/protocol/src/rollup/disclosure.ts';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import {akOf} from '../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {Results,checkDisclosure,fullViewOf,noteStateOf,type Checked} from '../app/src/Disclose.tsx';
import {epochIncomingNotes,epochRevealLinkOf} from '../src/shielded/epoch-disclosure.ts';
import type {EpochBatchPage} from '../src/shielded/epoch-sync.ts';
import type {PoolApi} from '../src/shielded/pool.ts';
import {epochPool,posted} from './fixtures/epoch-pool.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {default:ShieldedHome}=await import('../app/src/ShieldedHome.tsx');

const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const [aliceKeys,bobKeys]=['11','22'].map(byte=>deriveRollupKeys2(byte.repeat(32),'mutinynet')) as [ReturnType<typeof deriveRollupKeys2>,ReturnType<typeof deriveRollupKeys2>];
const [aliceTo,bobTo]=[aliceKeys,bobKeys].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret)) as [ReturnType<typeof rollupRecipientOf>,ReturnType<typeof rollupRecipientOf>];
const [aliceAddress,bobAddress]=[aliceTo,bobTo].map(rollupAddressOf) as [string,string];
const EPOCH_LEN=4,TOKEN='ab'.repeat(34),OTHER='cd'.repeat(34);
const fresh=(keys:typeof aliceKeys)=>EpochAccount.owning(hash,keys,{epochLen:EPOCH_LEN});
const replay=async(account:EpochAccount,api:PoolApi)=>{for(const batch of (await api<EpochBatchPage>(`/batches?from=${account.batchCount}&limit=100`)).batches)await account.apply(batch);return account;};
const named=(api:PoolApi,token:string)=>(async(path:string)=>{const body=await api<{pool?:object}>(path);return path==='/status'?{...body,pool:{...body.pool,token}}:body;}) as PoolApi;
const plain=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/&#x27;/g,'\'').replace(/&amp;/g,'&').replace(/\s+/g,' ');
const pin=(circuit:string)=>readFileSync('tools/rollup-epoch-budget.mjs','utf8').match(new RegExp(`'${circuit}': \\{ nConstraints: ([\\d_]+)`))![1]!.replaceAll('_','');
const count=(n:string)=>Number(n).toLocaleString('en-US');

test('the landing page explains epochs, and the numbers in it are the code\'s',()=>{
 const html=renderToStaticMarkup(createElement(ShieldedHome)),text=plain(html);
 for(const phrase of ['IV Stay fresh','Notes that never expire, in a pool that never fills.','Fig. 3','The sealed epochs stay available','A recovery hides among one sealed epoch.'])assert.ok(text.includes(phrase),phrase);
 const epochLen=/SHIELDED_ROLLUP_EPOCH_LEN=(\d+)/.exec(readFileSync('Dockerfile.dokploy','utf8'))![1]!;
 const cells=(label:string)=>[...html.matchAll(new RegExp(`<dt>${label}</dt><dd>([^<]*)</dd>`,'g'))].map(m=>m[1]);
 assert.deepEqual(['Epoch length','Direct-spend window','Spent-note set','Sealed epochs','Recover batch'].map(label=>cells(label)),[[`${epochLen} batches`],['the epoch a note was made in, and the next'],[`per epoch, indexed, depth ${EPOCH_NULLIFIER_DEPTH}`],[`up to ${count(String(2**ARCHIVE_DEPTH-1))}`],[`${EPOCH_SLOTS.recover} slot, its own tapscript leaf`]]);
 assert.match(cells('Anonymity floor')[0]!,/once the pool has rotated/);
 assert.match(text,/Once the pool has rotated, a private payment hides among at least one whole epoch of notes/);
 assert.match(text,/the one after — between one and two epochs, depending on when it was made/);
 assert.match(text,/sealed spent-note sets of the epoch it came from and the one after\. The operator serves every one of them, and an hourly job mirrors a second copy to a GitHub release;/);
 assert.doesNotMatch(text,/two full epochs|Note lifetime/);
 assert.match(text,new RegExp(`epochs of ${epochLen} batches`));
 assert.match(text,new RegExp(`at batch ${epochLen} and every ${epochLen} batches after`));
 assert.match(text,new RegExp(`RS = indexed set, depth ${RECOVERED_DEPTH}`));
 assert.match(text,/statement = Poseidon\(domain, anchor, nf/,'epoch-spend.circom hashes the anchor into the statement, not a root');
 assert.deepEqual(cells('Constraints'),[count(pin('epoch-spend')),`${count(pin('epoch-batch-spend'))} (spend)`],'the proof sizes the CI budget job pins, not genesis 3\'s');
 assert.doesNotMatch(text,/genesis 3|\bASP\b|\bround\b/i);
 for(const doc of ['README.md','SECURITY.md'])assert.doesNotMatch(readFileSync(doc,'utf8'),/\bASP\b|\bround\b/i,doc);
});

test('the verify page names the pool it checked against, on a verified link and on a refused one',async()=>{
 const pool=epochPool(hash,EPOCH_LEN),other=epochPool(hash,EPOCH_LEN);
 pool.land('spend',[await pool.deposit(aliceTo,500n)]);
 pool.land('spend',(await (await replay(fresh(aliceKeys),pool.api)).pay(bobTo,100n,aliceTo)).spends.map(posted));
 other.land();other.land();
 const entry=(await replay(fresh(bobKeys),pool.api)).history.find(e=>e.kind==='receive')!;
 const disclosure=decodeDisclosure(epochRevealLinkOf('https://pool.test',entry,{self:bobAddress,sentOf:()=>undefined})!.split('#')[1]!);
 const down=(async(path:string)=>path==='/status'?Promise.reject(new Error('down')):pool.api(path)) as PoolApi;
 const [good,bad,unnamed]=await Promise.all([named(pool.api,TOKEN),named(other.api,OTHER),down].map(api=>checkDisclosure(hash,disclosure,api)));
 assert.deepEqual([good.ok,bad.ok,unnamed.ok,good.pool,bad.pool,unnamed.pool],[[true],[false],[true],TOKEN,OTHER,undefined]);
 const page=(checked:Checked)=>plain(renderToStaticMarkup(createElement(Results,{checked})));
 assert.match(page(good),new RegExp(`Verified: 100 sats.*${TOKEN}`));
 assert.doesNotMatch(page(good),/different pool/);
 assert.match(page(bad),new RegExp(`This does not match the pool.*link minted against a different pool.*cannot verify here.*${OTHER}`));
 assert.match(page(unnamed),/Verified: 100 sats.*Not reported/);
});

test('/watch refuses a pool that is not an open epoch pool in words, not with a TypeError',async()=>{
 const key=parseFullViewKey(hash,fullViewKeyOf(akOf(hash,aliceKeys.ask),aliceKeys.nk,aliceKeys.viewSecret));
 for(const status of [{phase:'starting',message:'Starting'},{phase:'ready',message:'',pool:{token:TOKEN,batches:0,root:'0'}}])
  await assert.rejects(fullViewOf(hash,key,(async()=>status) as unknown as PoolApi),(error:Error)=>!(error instanceof TypeError)&&error.message==='That pool is not an open epoch pool.');
});

test('/watch reads a note as unspent only while the wallet holds it, and names notes by epoch and leaf',async()=>{
 const pool=epochPool(hash,EPOCH_LEN);
 pool.land('spend',[await pool.deposit(aliceTo,500n),await pool.deposit(aliceTo,300n)]);
 const alice=await replay(fresh(aliceKeys),pool.api);
 // A self-payment spread over two notes nets to nothing, so the account records no entry for it.
 pool.land('spend',(await alice.pay(aliceTo,700n,aliceTo)).spends.map(posted));
 while(pool.state.batchCount<4)pool.land();
 await replay(alice,pool.api);
 const plan=alice.renewalDue({random:()=>0})!;
 pool.land(plan.kind,[posted(await alice.renew(plan,aliceTo))]);
 while(pool.state.batchCount<9)pool.land();
 await replay(alice,pool.api);
 pool.land('recover',[posted(await alice.recover(alice.notes().find(n=>n.epoch===0)!,aliceTo))]);
 await replay(alice,pool.api);
 pool.land('spend',(await alice.pay(bobTo,50n,aliceTo)).spends.map(posted));
 const key=parseFullViewKey(hash,fullViewKeyOf(akOf(hash,aliceKeys.ask),aliceKeys.nk,aliceKeys.viewSecret)),account=await fullViewOf(hash,key,pool.api),state=noteStateOf(account);
 assert.deepEqual(account.history.flatMap(e=>e.created.map(n=>[e.kind,e.batch,n.amount,state(n)])),[
  ['shield',0,500n,'Spent'],['shield',0,300n,'Spent'],['merge',4,300n,'Spent in batch #10'],['recover',9,500n,'Unspent'],['send',10,250n,'Unspent']]);
 const text=plain(renderToStaticMarkup(createElement(Results,{watched:{address:aliceAddress,entries:[...account.history],state}})));
 assert.deepEqual(text.match(/Note \d+\/\d+/g),['Note 2/65','Note 2/32','Note 1/0','Note 0/2','Note 0/0'],'newest first, each named epoch/leaf');
 assert.doesNotMatch(text,/Leaf/);
});

test('/watch reads a refreshed note as spent in the batch that refreshed it',async()=>{
 const pool=epochPool(hash,EPOCH_LEN);
 pool.land('spend',[await pool.deposit(aliceTo,500n)]);
 while(pool.state.batchCount<4)pool.land();
 const alice=await replay(fresh(aliceKeys),pool.api),plan=alice.renewalDue({random:()=>0})!;
 pool.land(plan.kind,[posted(await alice.renew(plan,aliceTo))]);
 const account=await fullViewOf(hash,parseFullViewKey(hash,fullViewKeyOf(akOf(hash,aliceKeys.ask),aliceKeys.nk,aliceKeys.viewSecret)),pool.api),state=noteStateOf(account);
 assert.deepEqual(account.history.flatMap(e=>e.created.map(n=>[e.kind,e.batch,state(n)])),[['shield',0,'Spent in batch #4'],['renew',4,'Unspent']]);
});

test('a view key lists the notes it can open by position, with no received total to overstate',async()=>{
 const pool=epochPool(hash,EPOCH_LEN);
 pool.land('spend',[await pool.deposit(aliceTo,500n),await pool.deposit(aliceTo,300n)]);
 const notes=await epochIncomingNotes(hash,pool.records,parseViewKey(viewKeyOf(aliceTo.owner,aliceKeys.viewSecret)));
 const text=plain(renderToStaticMarkup(createElement(Results,{watched:{address:aliceAddress,notes}})));
 assert.match(text,/2 notes seen/);
 assert.deepEqual(text.match(/Position \d+/g),['Position 2','Position 0']);
 assert.doesNotMatch(text,/Leaf|Received [\d,]+ (sats|asset)/);
});
