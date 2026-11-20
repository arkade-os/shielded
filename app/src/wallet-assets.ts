import {arkTarget,isValidArkAddress,type AssetDetails} from '@arkade-os/sdk';
import {arkAssetHoldings} from './rollup-client.ts';
import type {ArkCoin} from '../../src/shielded/pool.ts';
export const UNVERIFIED='Unverified';
export const MAX_ASSET_DECIMALS=18;
export type AssetMeta={name?:string;ticker?:string;decimals:number};

const TICKER=/^[A-Za-z0-9.-]{1,12}$/;
const BITCOIN_UNITS=new Set(['sat','sats','msat','msats','btc','xbt','mbtc','bit','bits','bitcoin','satoshi','satoshis']);
const TYPED=/^(0|[1-9]\d*)(\.\d+)?$/;
const MAX_ATOMIC=2n**64n;

function decimalsOf(x:unknown):number{
 return typeof x==='number'&&Number.isInteger(x)&&x>=0&&x<=MAX_ASSET_DECIMALS?x:0;
}

export function assetMetaOf(metadata:unknown):AssetMeta{
 const m=(metadata&&typeof metadata==='object'?metadata:{}) as Record<string,unknown>;
 const meta:AssetMeta={decimals:decimalsOf(m.decimals)};
 const name=typeof m.name==='string'?Array.from(m.name.replace(/[\p{Cc}\p{Cf}\p{Sc}]/gu,'').trim()).slice(0,32).join('').trim():'';
 if(name&&!BITCOIN_UNITS.has(name.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{Sc}]/gu,'')))meta.name=name;
 if(typeof m.ticker==='string'&&TICKER.test(m.ticker)&&!BITCOIN_UNITS.has(m.ticker.toLowerCase().replace(/[.-]/g,'')))meta.ticker=m.ticker;
 return meta;
}

export function formatAssetAmount(atomic:bigint,decimals:number,grouping=true):string{
 const d=decimalsOf(decimals);
 const text=atomic.toString().padStart(d+1,'0');
 let whole=text.slice(0,text.length-d);
 const fraction=text.slice(text.length-d).replace(/0+$/,'');
 if(grouping)whole=whole.replace(/\B(?=(\d{3})+$)/g,',');
 return fraction?`${whole}.${fraction}`:whole;
}

export function parseAssetAmount(text:string,decimals:number):bigint|undefined{
 const d=decimalsOf(decimals);
 if(!TYPED.test(text))return undefined;
 const [whole,fraction='']=text.split('.');
 if(fraction.length>d)return undefined;
 const atomic=BigInt(whole+fraction.padEnd(d,'0'));
 return atomic>0n&&atomic<MAX_ATOMIC?atomic:undefined;
}

export function assetAmountError(decimals:number,unit:string):string{
 return decimals===0
  ?`Enter a whole number of ${unit} above zero, without leading zeros.`
  :`Enter an amount of ${unit} above zero, with at most ${decimals} decimal places.`;
}

const shortId=(id:string)=>`${id.slice(0,8)}…${id.slice(-4)}`;

export function assetTitle(assetId:string,meta?:AssetMeta):string{
 if(meta?.name)return meta.ticker?`${meta.name} (${meta.ticker})`:meta.name;
 return `Asset ${shortId(assetId)}${meta?.ticker?` (${meta.ticker})`:''}`;
}

export function assetUnit(meta?:AssetMeta):string{
 return meta?.ticker??'units';
}

export function assetText(atomic:bigint,assetId:string,meta?:AssetMeta):string{
 const amount=formatAssetAmount(atomic,meta?.decimals??0);
 const body=meta?.ticker?`${amount} ${meta.ticker}`:`${amount} units of asset ${shortId(assetId)}`;
 return `${body} · ${UNVERIFIED}`;
}

export const ASSET_METADATA_KEY='shielded-asset-metadata-v1:';
export const ASSET_METADATA_TTL_MS=86_400_000;
export const ASSET_METADATA_RETRY_MS=60_000;
export const MAX_ASSET_LOOKUPS=100;

const ASSET_ID=/^[0-9a-f]{68}$/;
type Entry={meta:AssetMeta;at:number};

export function assetMetadata(o:{storage:Pick<Storage,'getItem'|'setItem'>;details:(assetId:string)=>Promise<Pick<AssetDetails,'metadata'>>;onChange:()=>void;now?:()=>number}){
 const now=o.now??Date.now,memory=new Map<string,Entry>(),began=new Map<string,number>();
 function entry(id:string):Entry|undefined{
  const held=memory.get(id);if(held)return held;
  try{
   const raw=JSON.parse(o.storage.getItem(ASSET_METADATA_KEY+id)??'null');
   if(raw&&typeof raw==='object'&&Number.isFinite(raw.at)){const e={meta:assetMetaOf(raw),at:raw.at};memory.set(id,e);return e;}
  }catch{}
  return undefined;
 }
 async function lookup(id:string){
  try{
   const meta=assetMetaOf((await o.details(id)).metadata),at=now();
   memory.set(id,{meta,at});
   try{o.storage.setItem(ASSET_METADATA_KEY+id,JSON.stringify({...meta,at}));}catch{}
   o.onChange();
  }catch{}
 }
 return {
  get:(id:string)=>entry(id)?.meta,
  want(ids:Iterable<string>){
   const t=now(),todo=new Set<string>();
   for(const id of ids){
    if(todo.size>=MAX_ASSET_LOOKUPS)break;
    if(!ASSET_ID.test(id)||todo.has(id))continue;
    const e=entry(id),tried=began.get(id);
    if(e&&t-e.at<=ASSET_METADATA_TTL_MS)continue;
    if(tried!==undefined&&t-tried<ASSET_METADATA_RETRY_MS)continue;
    todo.add(id);began.set(id,t);
   }
   for(const id of todo)void lookup(id);
  },
 };
}

export type HeldAsset={assetId:string;shielded:bigint;unshielded:bigint};
export type HoldingKind='shielded'|'unshielded'|'both';
export const KIND_TEXT={shielded:'Shielded',unshielded:'Unshielded',both:'Shielded and unshielded'};
export const UNSHIELDED_ASSET_RECIPIENT='This asset is outside the pool, so it can be sent only to an Arkade address. Shielded addresses, Lightning and Bitcoin addresses cannot receive it.';

export function heldAssets(o:{reserves:readonly string[];shielded:(assetId:string)=>bigint;coins:readonly ArkCoin[]}):HeldAsset[]{
 const rows=new Map<string,HeldAsset>();
 const row=(assetId:string)=>{let r=rows.get(assetId);if(!r)rows.set(assetId,r={assetId,shielded:0n,unshielded:0n});return r;};
 for(const id of o.reserves)row(id).shielded+=o.shielded(id);
 for(const h of arkAssetHoldings(o.coins,()=>false))row(h.assetId).unshielded+=h.units;
 return [...rows.values()].filter(r=>r.shielded>0n||r.unshielded>0n).sort((a,b)=>a.assetId<b.assetId?-1:1);
}

export const holdingKind=(a:HeldAsset):HoldingKind=>a.shielded>0n?(a.unshielded>0n?'both':'shielded'):'unshielded';

export function requestAssets(mode:'unified'|'shielded'|'arkade',held:readonly HeldAsset[],reserves:readonly string[],known:(assetId:string)=>boolean):string[]{
 const ids=mode==='arkade'?held.map(h=>h.assetId):mode==='shielded'?reserves:[];
 return ids.filter(known);
}

export function assetRecipientError(asset:HeldAsset|undefined,to:string):string{
 if(!asset||asset.shielded!==0n||!to.trim())return '';
 try{const ark=arkTarget(to.trim());if(ark&&isValidArkAddress(ark))return '';}catch{}
 return UNSHIELDED_ASSET_RECIPIENT;
}

export const unshieldedLimitLine=(amount:string,unit:string)=>`Up to ${amount} ${unit} on Arkade, outside the pool. Sending it makes the amount public.`;
