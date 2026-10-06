import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {SingleKey} from '@arkade-os/sdk';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {EngineStore} from '../src/storage.ts';
import {preflightStockMutinynet} from '../src/stock/network.ts';
import {openCustomerArkWallet} from '../src/stock/ark-wallet.ts';

if(!process.argv.includes('--prepare'))throw new Error('Pass --prepare to create or inspect the separate stock test funding wallet. This tool does not submit transactions.');
const directory=resolve('.recovery/stock-funding-wallet'),store=EngineStore.open(directory);
try{
 let saved=store.load<{version:1;purpose:string;network:string;masterSecret:string}>();
 if(!saved){saved={version:1,purpose:'new-stock-profile-test-funding',network:'mutinynet',masterSecret:randomBytes(32).toString('hex')};store.save(saved);}
 if(saved.version!==1||saved.purpose!=='new-stock-profile-test-funding'||saved.network!=='mutinynet')throw new Error('The stock funding directory contains a different wallet.');
 const network=await preflightStockMutinynet(),material=deriveWalletKeyMaterial(saved.masterSecret,'mutinynet'),ark=await openCustomerArkWallet(SingleKey.fromHex(material.nativeSecret),network);
 console.log(JSON.stringify({network:'mutinynet',purpose:saved.purpose,address:ark.address,spendableSats:ark.coins.reduce((sum,coin)=>sum+coin.amount,0),spendableVtxos:ark.coins.length,transactionsSubmitted:0},null,2));
}finally{store.close();}
process.exit(0);
