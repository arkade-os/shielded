import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'node:test';
import WalletSyncStatus from '../app/src/WalletSyncStatus.tsx';
import {pageBusyText} from '../app/src/shielded-page.ts';

test('the wallet does not stay in a sync state after its private account is ready',()=>{
 assert.equal(renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:true,arkReady:false,error:''})),'');
});

test('the wallet still announces an initial balance wait or a refresh error',()=>{
 assert.match(renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:false,error:''})),/Syncing your private balance/);
 assert.match(renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:true,error:'Indexer unavailable'})),/Recovering wallet data/);
});

test('a rate limit reads as a busy service showing the saved balance, with no retry to press',()=>{
 const markup=renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:true,error:pageBusyText(40_000),onRetry(){}}));
 assert.match(markup,/Wallet services are busy\. Showing your saved balance; retrying in 40 s\./);
 assert.doesNotMatch(markup,/Recovering wallet data|Failed to fetch UTXOs|Too Many Requests|Retry connection/);
});

test('an ordinary refresh failure keeps its own text and its retry', ()=>{
 const markup=renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:true,error:'Indexer unavailable',onRetry(){}}));
 assert.match(markup,/Recovering wallet data/);assert.match(markup,/Retry connection/);
});
