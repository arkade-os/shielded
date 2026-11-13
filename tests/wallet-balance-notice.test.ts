import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TxType,type Activity} from '@arkade-os/sdk';
import {pageActivityNotice} from '../app/src/shielded-page.ts';

registerHooks({load:(url,context,next)=>url.endsWith('.css')?{format:'module',source:'export {}',shortCircuit:true}:next(url,context)});
const {WalletBalanceNotice}=await import('../app/src/components.tsx');
const row=(id:string,amount:number,createdAt:number,settled=true)=>({id,amount,createdAt,settled,
 txs:[{key:{arkTxid:id,boardingTxid:'',commitmentTxid:''},type:amount>0?TxType.TxReceived:TxType.TxSent,amount:Math.abs(amount),settled,createdAt}]}) as Activity;

test('the first load of a wallet session seeds the seen rows without announcing its history',()=>{
 const history=[row('a',1000,200),row('b',-500,100)];
 const first=pageActivityNotice(history,undefined,3);
 assert.equal(first.notice,undefined);assert.deepEqual([...first.seen.ids].sort(),['a','b']);
 assert.equal(pageActivityNotice(history,first.seen,3).notice,undefined);
 assert.equal(pageActivityNotice([],undefined,3).notice,undefined);
});

test('money in and money out each announce their own direction and amount',()=>{
 const seen=pageActivityNotice([row('a',1000,100)],undefined,3).seen;
 const received=pageActivityNotice([row('b',1000,200),row('a',1000,100)],seen,3);
 assert.deepEqual(received.notice,{id:'b',text:'Received 1,000 sats',detail:'',received:true,more:0});
 const sent=pageActivityNotice([row('c',-500,300),row('a',1000,100)],seen,3);
 assert.deepEqual(sent.notice,{id:'c',text:'Sent 500 sats',detail:'',received:false,more:0});
 assert.equal(pageActivityNotice([row('d',1,400),row('a',1000,100)],seen,3).notice?.text,'Received 1 sat');
});

test('an unsettled row carries a pending marker and a zero-amount row never announces',()=>{
 const seen=pageActivityNotice([],undefined,3).seen;
 assert.equal(pageActivityNotice([row('b',1000,200,false)],seen,3).notice?.detail,'Arriving; not settled yet');
 assert.equal(pageActivityNotice([row('c',-500,200,false)],seen,3).notice?.detail,'Not settled yet');
 const merge=pageActivityNotice([row('m',0,200)],seen,3);
 assert.equal(merge.notice,undefined);assert.ok(merge.seen.ids.has('m'));
});

test('an automatic shield or a merge moves the wallet’s own funds and never announces',()=>{
 const seen=pageActivityNotice([],undefined,3).seen;
 for(const kind of ['shield','merge']){
  const moved=pageActivityNotice([Object.assign(row('s',-500,200),{intent:{kind,label:'Shielded'}})],seen,3);
  assert.equal(moved.notice,undefined);assert.ok(moved.seen.ids.has('s'));
 }
});

test('several new rows announce the newest and how many more, and never announce twice',()=>{
 const seen=pageActivityNotice([row('a',1000,100)],undefined,3).seen;
 const burst=pageActivityNotice([row('a',1000,100),row('b',700,200),row('c',-300,400),row('d',900,300)],seen,3);
 assert.equal(burst.notice?.id,'c');assert.equal(burst.notice?.text,'Sent 300 sats');assert.equal(burst.notice?.more,2);
 assert.equal(pageActivityNotice([row('a',1000,100),row('b',700,200),row('c',-300,400),row('d',900,300)],burst.seen,3).notice,undefined);
});

test('a shrunken history read cannot re-announce a row that was already seen',()=>{
 const seen=pageActivityNotice([row('a',1000,100),row('b',700,200)],undefined,3).seen;
 const partial=pageActivityNotice([row('a',1000,100)],seen,3);
 assert.equal(partial.notice,undefined);
 assert.equal(pageActivityNotice([row('a',1000,100),row('b',700,200)],partial.seen,3).notice,undefined);
});

test('a history source answering after another, such as Lightning starting late, is seeded rather than announced',()=>{
 const lightningOnly=pageActivityNotice([row('l',2000,50)],undefined,2).seen;
 const both=pageActivityNotice([row('a',1000,100),row('l',2000,50)],lightningOnly,3);
 assert.equal(both.notice,undefined);
 assert.equal(pageActivityNotice([row('a',1000,100),row('l',2000,50),row('n',700,300)],both.seen,3).notice?.id,'n');
});

const render=(notice:Parameters<typeof WalletBalanceNotice>[0]['notice'])=>renderToStaticMarkup(createElement(WalletBalanceNotice,{notice,onDismiss:()=>{}}));

test('the notice is a polite status with its amount, extras and a dismiss control',()=>{
 const html=render({id:'b',text:'Received 1,000 sats',detail:'Arriving; not settled yet',received:true,more:2});
 assert.match(html,/role="status" aria-live="polite"/);assert.match(html,/class="wallet-balance-notice"/);
 assert.match(html,/Received 1,000 sats/);assert.match(html,/and 2 more/);assert.match(html,/Arriving; not settled yet/);
 assert.match(html,/<button type="button" class="icon-button" aria-label="Dismiss"/);
 const sent=render({id:'c',text:'Sent 500 sats',detail:'',received:false,more:0});
 assert.match(sent,/class="out"/);assert.doesNotMatch(sent,/more|<em>/);
});

test('the notice sits at the top edge, clear of an open sheet, and respects reduced motion',()=>{
 const css=readFileSync(new URL('../app/src/wallet-glass.css',import.meta.url),'utf8');
 assert.match(css,/\.wallet-balance-notice\{[^}]*top:calc\(8px \+ env\(safe-area-inset-top\)\)/);
 assert.doesNotMatch(css,/\.native-wallet-topbar~\.stock-page \.wallet-balance-notice/);
 const reduced=css.split(/\r?\n/).filter(line=>line.startsWith('@media(prefers-reduced-motion:reduce)'));
 assert.ok(reduced.some(line=>line.includes('.wallet-balance-notice{animation:none}')));
});
