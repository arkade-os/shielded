export type IncomingPayment={id:number;uri:string};

const MAX_PAYMENT_URI_LENGTH=16*1024;

/** Select the first supported payment URI from an OS deep-link batch without rewriting its bech32 case. */
export function paymentDeepLink(urls:readonly string[]|null|undefined):string|undefined{
 for(const value of urls??[]){
  if(typeof value!=='string')continue;
  const uri=value.trim();
  if(uri.length<=MAX_PAYMENT_URI_LENGTH&&/^(?:bitcoin|lightning|arkade):[^\s\u0000-\u001f\u007f]+$/i.test(uri))return uri;
 }
 return undefined;
}
