import {useEffect,useRef,useState} from 'react';
import type {ExitQuote} from '@arkade-os/sdk';
import type {PrivateLightningService} from '../../src/shielded/lightning-wallet.ts';
import {errorText} from './shielded-page.ts';
import {CopyButton} from './components.tsx';

const formatNumber=(value:number)=>value.toLocaleString('en-US');
export function LightningRecoveryQuote({service,outpoint,disabled}:{service:Pick<PrivateLightningService,'quoteRecovery'>;outpoint:string;disabled:boolean}){
 const [quote,setQuote]=useState<ExitQuote>(),[pending,setPending]=useState(false),[error,setError]=useState(''),request=useRef(0);
 useEffect(()=>{setQuote(undefined);setPending(false);setError('');return()=>{request.current++;};},[service,outpoint]);
 const load=async()=>{
  const id=++request.current;setPending(true);setError('');setQuote(undefined);
  try{const result=await service.quoteRecovery(outpoint);if(id===request.current)setQuote(result);}
  catch(cause){if(id===request.current)setError(errorText(cause));}
  finally{if(id===request.current)setPending(false);}
 };
 const delay=quote?.vtxos[0]?.delay;
 return <><dt>Onchain recovery</dt><dd>
  <p className="stock-muted">Checks this payout and your onchain funding address with the Bitcoin explorer. No transaction is signed or broadcast.</p>
  <button type="button" className="stock-ghost stock-mini" disabled={disabled||pending} onClick={()=>void load()}>{pending?'Checking recovery…':quote?'Refresh recovery quote':'Check onchain recovery'}</button>
  {error&&<p className="stock-blocked" role="alert">{error}</p>}
  {quote&&<div className="stock-address" role="status">
   <dl>
    <dt>Recovered after the sweep fee</dt><dd>{formatNumber(quote.totals.recoveredSats)} sats</dd>
    <dt>Total mining fees</dt><dd>{formatNumber(quote.totals.totalFeeSats)} sats at {formatNumber(quote.feeRate)} sat/vB</dd>
    <dt>Transactions</dt><dd>{quote.totals.txCount}</dd>
    {delay&&<><dt>Recovery delay</dt><dd>{formatNumber(delay.value)} {delay.type} after the payout confirms onchain</dd></>}
    <dt>Total onchain funding</dt><dd>{formatNumber(quote.totals.fundingRequiredSats)} sats</dd>
    <dt>Already confirmed onchain</dt><dd>{formatNumber(quote.currentBalanceSats)} sats</dd>
    <dt>Onchain funds needed</dt><dd>{formatNumber(quote.shortfallSats)} additional sats</dd>
    <dt>Onchain wallet address</dt><dd><div className="stock-copy"><code>{quote.fundingAddress}</code><CopyButton value={quote.fundingAddress}/></div><p className="stock-muted">Fee funding and recovered sats both arrive here.</p></dd>
   </dl>
   <p className="stock-muted">Shielding continues while you view this quote. Starting recovery would publish the payout on Bitcoin; its delay starts at onchain confirmation. Fee funding includes the fee transaction outputs; unused funds stay in your onchain wallet.</p>
   {quote.validUntil!==undefined&&<p className="stock-muted">The underlying batch expires {new Date(quote.validUntil*1000).toLocaleString()}. Refresh the quote before starting recovery.</p>}
  </div>}
 </dd></>;
}
