import test from 'node:test';
import assert from 'node:assert/strict';
import {loadStockInstallConfig} from '../src/stock/config.ts';
import {MUTINY_ARK_URL,MUTINY_EMULATOR_URL} from '../src/stock/network.ts';

test('stock install config defaults to Mutinynet, persistent data, and no secret bootstrap input',()=>{
 const config=loadStockInstallConfig({});
 assert.deepEqual(config.network,{name:'mutinynet',arkUrl:MUTINY_ARK_URL,emulatorUrl:MUTINY_EMULATOR_URL,indexerUrl:MUTINY_ARK_URL,dataDirectory:'/data'});
 assert.equal(config.allowDevelopmentSetup,false);
 assert.deepEqual(config.secrets,{});
});

test('stock install config separates mnemonic and accepts independent service URLs',()=>{
 const config=loadStockInstallConfig({SHIELDED_NETWORK:'mutinynet',SHIELDED_ARK_URL:'https://ark.example/',SHIELDED_EMULATOR_URL:'http://emulator.example',SHIELDED_INDEXER_URL:'https://indexer.example',SHIELDED_DATA_DIR:'/srv/shielded',SHIELDED_BOOTSTRAP_MNEMONIC:' twelve words ',SHIELDED_ALLOW_DEV_SETUP:'true'});
 assert.deepEqual(config.network,{name:'mutinynet',arkUrl:'https://ark.example',emulatorUrl:'http://emulator.example',indexerUrl:'https://indexer.example',dataDirectory:'/srv/shielded'});
 assert.deepEqual(config.secrets,{bootstrapMnemonic:'twelve words'});
 assert.equal(config.allowDevelopmentSetup,true);
 assert.equal(JSON.stringify(config.network).includes('twelve words'),false);
});

test('stock install config rejects unsupported network, unsafe URLs, and ambiguous storage paths',()=>{
 assert.throws(()=>loadStockInstallConfig({SHIELDED_NETWORK:'mainnet'}),/only mutinynet/);
 for(const arkUrl of ['not a URL','ftp://ark.example','https://user:pass@ark.example','https://ark.example/path','https://ark.example/?token=x','https://ark.example/#part'])
  assert.throws(()=>loadStockInstallConfig({SHIELDED_ARK_URL:arkUrl}),/SHIELDED_ARK_URL/);
 assert.throws(()=>loadStockInstallConfig({SHIELDED_DATA_DIR:'data'}),/absolute/);
 assert.throws(()=>loadStockInstallConfig({SHIELDED_DATA_DIR:'/one',SHIELDED_STOCK_DATA_DIR:'/two'}),/disagree/);
 assert.throws(()=>loadStockInstallConfig({SHIELDED_ALLOW_DEV_SETUP:'true',SHIELDED_STOCK_ALLOW_DEV_SETUP:'false'}),/must agree/);
 assert.throws(()=>loadStockInstallConfig({SHIELDED_ALLOW_DEV_SETUP:'yes'}),/true or false/);
});
