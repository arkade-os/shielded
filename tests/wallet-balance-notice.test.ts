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
 const first=pageActivityNotice(history,undefined);
 assert.equal(first.notice,undefined);assert.deepEqual([...first.seen].sort(),['a','b']);
 assert.equal(pageActivityNotice(history,first.seen).notice,undefined);
 assert.equal(pageActivityNotice([],undefined).notice,undefined);
});

test('money in and money out each announce their own direction and amount',()=>{
 const seen=pageActivityNotice([row('a',1000,100)],undefined).seen;
 const received=pageActivityNotice([row('b',1000,200),row('a',1000,100)],seen);
 assert.deepEqual(received.notice,{id:'b',text:'Received 1,000 sats',detail:'',received:true,more:0});
 const sent=pageActivityNotice([row('c',-500,300),row('a',1000,100)],seen);
 assert.deepEqual(sent.notice,{id:'c',text:'Sent 500 sats',detail:'',received:false,more:0});
 assert.equal(pageActivityNotice([row('d',1,400),row('a',1000,100)],seen).notice?.text,'Received 1 sat');
});

test('an unsettled row carries a pending marker and a zero-amount row never announces',()=>{
 const seen=pageActivityNotice([],undefined).seen;
 assert.equal(pageActivityNotice([row('b',1000,200,false)],seen).notice?.detail,'Arriving; not settled yet');
 assert.equal(pageActivityNotice([row('c',-500,200,false)],seen).notice?.detail,'Not settled yet');
 const merge=pageActivityNotice([row('m',0,200)],seen);
 assert.equal(merge.notice,undefined);assert.ok(merge.seen.has('m'));
});

test('an automatic shield or a merge moves the wallet’s own funds and never announces',()=>{
 const seen=pageActivityNotice([],undefined).seen;
 for(const kind of ['shield','merge']){
  const moved=pageActivityNotice([Object.assign(row('s',-500,200),{intent:{kind,label:'Shielded'}})],seen);
  assert.equal(moved.notice,undefined);assert.ok(moved.seen.has('s'));
 }
});

test('several new rows announce the newest and how many more, and never announce twice',()=>{
 const seen=pageActivityNotice([row('a',1000,100)],undefined).seen;
 const burst=pageActivityNotice([row('a',1000,100),row('b',700,200),row('c',-300,400),row('d',900,300)],seen);
 assert.equal(burst.notice?.id,'c');assert.equal(burst.notice?.text,'Sent 300 sats');assert.equal(burst.notice?.more,2);
 assert.equal(pageActivityNotice([row('a',1000,100),row('b',700,200),row('c',-300,400),row('d',900,300)],burst.seen).notice,undefined);
});

test('a shrunken history read cannot re-announce a row that was already seen',()=>{
 const seen=pageActivityNotice([row('a',1000,100),row('b',700,200)],undefined).seen;
 const partial=pageActivityNotice([row('a',1000,100)],seen);
 assert.equal(partial.notice,undefined);
 assert.equal(pageActivityNotice([row('a',1000,100),row('b',700,200)],partial.seen).notice,undefined);
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
