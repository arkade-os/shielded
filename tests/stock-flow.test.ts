import test from 'node:test';
import assert from 'node:assert/strict';
import {ArkAddress} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {autoShieldCoins,noteSummary,parseRecipient,sealedAfter} from '../app/src/stock-flow.ts';

const self='aa'.repeat(32),other='bb'.repeat(32),serverKey='11'.repeat(32),options={self,serverKey,participants:{[self]:{},[other]:{}}};
const address=(server=serverKey,hrp='tark')=>new ArkAddress(hex.decode(server),hex.decode('22'.repeat(32)),hrp).encode();
test('recipient is a registered wallet ID or an Arkade address on this server',()=>{
 assert.deepEqual(parseRecipient(` ${other.toUpperCase()} `,options),{kind:'wallet',owner:other});
 assert.deepEqual(parseRecipient(address(),options),{kind:'arkade',address:address(),program:'22'.repeat(32)});
 assert.throws(()=>parseRecipient(self,options),/your own wallet/);
 assert.throws(()=>parseRecipient('cc'.repeat(32),options),/not registered/);
 assert.throws(()=>parseRecipient(address('33'.repeat(32)),options),/different Arkade server/);
 assert.throws(()=>parseRecipient(address(serverKey,'ark'),options),/Mutinynet/);
 assert.throws(()=>parseRecipient('hello',options),/wallet ID or an Arkade address/);
});
test('auto-shield skips pool payouts and takes the largest coin first',()=>{
 const coin=(amount:number,txid:string)=>({amount,funding:{txid}});
 assert.deepEqual(autoShieldCoins([coin(400,'a'),coin(1200,'b'),coin(800,'c')],[{receipt:{txid:'c'}}]),[coin(1200,'b'),coin(400,'a')]);
});
test('balances split sealed and sealing notes; one note bounds a send',()=>{
 const notes=[{amount:500,spent:false,spendable:true},{amount:900,spent:false,spendable:true},{amount:300,spent:false,spendable:false},{amount:2000,spent:true,spendable:true}];
 assert.deepEqual(noteSummary(notes),{spendable:1400,sealing:300,maxSendable:900,maxAfterSeal:900});
 assert.equal(noteSummary([...notes,{amount:1500,spent:false,spendable:false}]).maxAfterSeal,1500);
 assert.deepEqual(noteSummary([]),{spendable:0,sealing:0,maxSendable:0,maxAfterSeal:0});
});
test('new notes need a seal until a later seal entry exists',()=>{
 const history=[{operation:'deposit',prepared:{id:'a'}},{operation:'prepare'},{operation:'seal'},{operation:'transfer',prepared:{id:'b'}}];
 assert.equal(sealedAfter(history,'a'),true);
 assert.equal(sealedAfter(history,'b'),false);
 assert.equal(sealedAfter(history,'missing'),false);
});
