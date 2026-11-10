import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test} from 'node:test';
import WalletSyncStatus from '../app/src/WalletSyncStatus.tsx';

test('the wallet does not stay in a sync state after its private account is ready',()=>{
 assert.equal(renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:true,arkReady:false,error:''})),'');
});

test('the wallet still announces an initial balance wait or a refresh error',()=>{
 assert.match(renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:false,error:''})),/Syncing your private balance/);
 assert.match(renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady:true,error:'Indexer unavailable'})),/Recovering wallet data/);
});
