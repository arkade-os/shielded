import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import WalletSyncStatus from '../app/src/WalletSyncStatus.tsx';

const render=(privateReady:boolean,arkReady:boolean,error='')=>renderToStaticMarkup(createElement(WalletSyncStatus,{privateReady,arkReady,error,onRetry:()=>{}}));
test('private balance readiness is separate from a delayed Arkade balance',()=>{
 assert.match(render(true,false),/Checking your Arkade balance/);
 assert.doesNotMatch(render(true,false),/Syncing your private balance/);
 assert.match(render(false,false),/Syncing your private balance/);
 assert.equal(render(true,true),'');
});
test('pending reads keep polling quietly while failures expose a recovery action',()=>{
 for(const html of [render(false,false),render(true,false)])assert.doesNotMatch(html,/>Retry connection<\/button>/);
 assert.match(render(true,true,'Service unavailable'),/>Retry connection<\/button>/);
 assert.match(render(true,false,'Service unavailable'),/Recovering wallet data/);
});

test('a retained wallet read reports recovery without a restart',()=>{
 const html=render(true,true,'Service unavailable');
 assert.match(html,/Recovering wallet data/);
 assert.doesNotMatch(html,/Syncing your wallet/);
});
