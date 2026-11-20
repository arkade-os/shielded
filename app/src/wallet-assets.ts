import type {AssetDetails} from '@arkade-os/sdk';
export const UNVERIFIED='Unverified';
export const MAX_ASSET_DECIMALS=18;
export type AssetMeta={name?:string;ticker?:string;decimals:number};

const TICKER=/^[A-Za-z0-9.-]{1,12}$/;
const TYPED=/^(0|[1-9]\d*)(\.\d+)?$/;
const MAX_ATOMIC=2n**64n;

function decimalsOf(x:unknown):number{
 return typeof x==='number'&&Number.isInteger(x)&&x>=0&&x<=MAX_ASSET_DECIMALS?x:0;
}

export function assetMetaOf(metadata:unknown):AssetMeta{
 const m=(metadata&&typeof metadata==='object'?metadata:{}) as Record<string,unknown>;
 const meta:AssetMeta={decimals:decimalsOf(m.decimals)};
 const name=typeof m.name==='string'?Array.from(m.name.replace(/[\p{Cc}\p{Cf}]/gu,'').trim()).slice(0,32).join('').trim():'';
 if(name)meta.name=name;
 if(typeof m.ticker==='string'&&TICKER.test(m.ticker))meta.ticker=m.ticker;
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
