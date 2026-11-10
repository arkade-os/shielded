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

type PaymentDeepLinkSource={
 onOpenUrl(receive:(urls:string[]|null)=>void):Promise<()=>void>;
 getCurrent():Promise<string[]|null>;
};

/** Follow live payment events, and use an older launch lookup only when no later event arrived. */
export function watchPaymentDeepLinks(source:PaymentDeepLinkSource,receive:(uri:string)=>void):()=>void{
 let live=true,eventReceived=false,unlisten:(()=>void)|undefined;
 const deliver=(urls:string[]|null,event=false)=>{
  if(!live)return;
  const uri=paymentDeepLink(urls);
  if(!uri)return;
  if(event)eventReceived=true;
  receive(uri);
 };
 void source.onOpenUrl(urls=>deliver(urls,true)).then(remove=>{if(live)unlisten=remove;else remove();}).catch(()=>{});
 void source.getCurrent().then(urls=>{if(!eventReceived)deliver(urls);}).catch(()=>{});
 return()=>{live=false;unlisten?.();};
}
