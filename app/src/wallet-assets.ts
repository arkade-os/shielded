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
 return meta?.ticker??`Asset ${shortId(assetId)}`;
}

export function assetUnit(meta?:AssetMeta):string{
 return meta?.ticker??'units';
}

export function assetText(atomic:bigint,assetId:string,meta?:AssetMeta):string{
 const amount=formatAssetAmount(atomic,meta?.decimals??0);
 const body=meta?.ticker?`${amount} ${meta.ticker}`:`${amount} units of asset ${shortId(assetId)}`;
 return `${body} · ${UNVERIFIED}`;
}
