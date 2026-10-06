import { secp256k1 } from '@noble/curves/secp256k1.js';
export const MUTINY_ARK_URL = 'https://mutinynet.arkade.sh';
export const MUTINY_EMULATOR_URL = 'https://emulator.mutinynet.arkade.sh';
export interface StockNetworkInfo {
 network: 'mutinynet';
 arkUrl: string;
 emulatorUrl: string;
 serverKey: string;
 emulatorKey: string;
 operatorMaxWeight: number;
 weightLimit: number;
 dust: number;
 exitDelay: {type:'blocks'|'seconds';value:number};
 emulatorVersion: string;
 nativeAdmission: 'unverified';
}
function fail(message:string):never{throw new Error('Stock Mutinynet preflight failed: '+message);}
function integer(value:unknown,label:string):number {
 if(typeof value!=='number'&&typeof value!=='string')fail(label+' is missing.');
 if(typeof value==='string'&&!/^(0|[1-9][0-9]*)$/.test(value))fail(label+' is not a canonical integer.');
 const parsed=Number(value);
 if(!Number.isSafeInteger(parsed)||parsed<1)fail(label+' is out of range.');
 return parsed;
}
function xonly(value:unknown,label:string):string {
 if(typeof value!=='string'||!/^(02|03)[0-9a-f]{64}$/.test(value))fail(label+' is malformed.');
 try{secp256k1.Point.fromHex(value);}catch{return fail(label+' is not a secp256k1 point.');}
 return value.slice(2);
}
export function parseStockNetworkInfo(ark:any,emulator:any,expected?:{serverKey:string;emulatorKey:string}):StockNetworkInfo {
 if(!ark||ark.network!=='mutinynet')fail('the operator is on a different network.');
 const serverKey=xonly(ark.signerPubkey,'Arkade signer key'),emulatorKey=xonly(emulator?.signerPubkey,'emulator signer key');
 if(expected&&(expected.serverKey!==serverKey||expected.emulatorKey!==emulatorKey))fail('signer keys changed; the funded immutable profile cannot be replaced.');
 const operatorMaxWeight=integer(ark.maxTxWeight,'operator weight limit'),dust=integer(ark.dust,'operator dust');
 const delay=integer(ark.unilateralExitDelay,'operator unilateral exit delay');
 if(delay>=512&&(delay%512!==0||delay/512>65535))fail('operator exit delay is not a canonical BIP68 duration.');
 const exitDelay={type:delay<512?'blocks' as const:'seconds' as const,value:delay};
 if(dust>330)fail('operator dust exceeds the immutable 330-sat pool carrier.');
 if(typeof emulator?.version!=='string'||emulator.version.length>128||!emulator.version)fail('emulator version is missing.');
 return {network:'mutinynet',arkUrl:MUTINY_ARK_URL,emulatorUrl:MUTINY_EMULATOR_URL,serverKey,emulatorKey,operatorMaxWeight,weightLimit:Math.min(operatorMaxWeight,4000),dust,exitDelay,emulatorVersion:emulator.version,nativeAdmission:'unverified'};
}
async function info(url:string,fetcher:typeof fetch):Promise<unknown> {
 const response=await fetcher(url+'/v1/info',{signal:AbortSignal.timeout(15_000),redirect:'error'});
 if(!response.ok)fail('public info endpoint returned HTTP '+response.status);
 const reader=response.body?.getReader();if(!reader)fail('public info endpoint returned no body.');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>64*1024)fail('public info response exceeds the limit.');chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>undefined);throw error;}
 const data=new Uint8Array(size);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{return fail('public info endpoint returned invalid JSON.');}
}
export async function preflightStockMutinynet(options:{fetcher?:typeof fetch;expected?:{serverKey:string;emulatorKey:string}}={}):Promise<StockNetworkInfo> {
 const fetcher=options.fetcher??fetch;
 const results=await Promise.allSettled([info(MUTINY_ARK_URL,fetcher),info(MUTINY_EMULATOR_URL,fetcher)]);
 const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
 return parseStockNetworkInfo((results[0] as PromiseFulfilledResult<unknown>).value,(results[1] as PromiseFulfilledResult<unknown>).value,options.expected);
}
export function assertStockWeightBudget(network:StockNetworkInfo,weights:{ark:number;checkpoints:number[]}):void {
 if(!Number.isSafeInteger(weights.ark)||weights.ark<1||!Array.isArray(weights.checkpoints)||!weights.checkpoints.length||weights.checkpoints.some(weight=>!Number.isSafeInteger(weight)||weight<1))fail('missing signed transaction weights.');
 if(weights.ark>network.weightLimit||weights.checkpoints.some(weight=>weight>network.weightLimit))fail('signed transaction exceeds min(operator limit, 4000 WU).');
}
