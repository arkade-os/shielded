import test from 'node:test';
import assert from 'node:assert/strict';
import {stockSetupPresentation,stockWalletStatus,type StockSetup} from '../app/src/stock-setup.ts';

const setup=(phase:StockSetup['phase']):StockSetup=>({version:1,network:'mutinynet',phase,minimumFundingSats:660,fundingAddress:'test-bootstrap-address'});
test('unfinished pool setup never claims proofs are loading or a wallet is ready',()=>{
 for(const phase of ['starting','qualifying','waiting-funds','bootstrapping','recovering','blocked'] as const){
  assert.equal(stockWalletStatus(setup(phase),true),undefined);
  assert.ok(stockSetupPresentation(setup(phase)).title);
 }
 assert.equal(stockWalletStatus(undefined,undefined),undefined);
 assert.equal(stockSetupPresentation(setup('qualifying')).funding,false);
 assert.equal(stockSetupPresentation(setup('waiting-funds')).funding,true);
 assert.match(stockSetupPresentation(setup('waiting-funds')).detail,/operator must fund/);
});
test('initialized pool details are distinct from client archive verification and errors',()=>{
 const profile={proofSystem:'Groth16',setup:'development phase 2',blockedReason:''};
 assert.match(stockWalletStatus(setup('ready'),true)!.state,/not verified/);
 assert.match(stockWalletStatus(setup('ready'),true,profile)!.state,/verify its archive/);
 assert.equal(stockWalletStatus(setup('ready'),true,profile,undefined,true)!.state,'Pool archive verified by this wallet.');
 assert.equal(stockWalletStatus(setup('ready'),true,undefined,'Gateway unavailable')!.state,'Gateway unavailable');
 assert.equal(stockWalletStatus(undefined,false,profile)!.proof,'Groth16');
});
test('qualification progress reports actual completed checks and transient failure remains visible',()=>{
 const value={...setup('qualifying'),qualification:{stage:'native-paths',completed:3,total:9}};
 assert.deepEqual(stockSetupPresentation(value).progress,{stage:'Verifying transaction paths',completed:3,total:9});
 assert.equal(stockSetupPresentation({...value,phase:'waiting-funds'}).progress,undefined);
 assert.match(stockSetupPresentation(value,'HTTP 502').detail,/HTTP 502.*Retrying automatically/);
 assert.equal(stockSetupPresentation(setup('qualifying')).progress,undefined);
});
