import {useEffect,useRef,useState} from 'react';
import {serializeExitPackage,type ExitQuote} from '@arkade-os/sdk';
import type {PrivateLightningService} from '../../src/shielded/lightning-wallet.ts';
import type {LightningRecovery} from '../../src/shielded/lightning-recovery.ts';
import {errorText} from './shielded-page.ts';
import {CopyButton} from './components.tsx';

const formatNumber=(value:number)=>value.toLocaleString('en-US');
export function LightningRecoveryQuote({service,outpoint,disabled}:{service:Pick<PrivateLightningService,'quoteRecovery'|'getRecovery'|'prepareRecovery'|'startRecovery'|'pauseRecovery'>;outpoint:string;disabled:boolean}){
 const [quote,setQuote]=useState<ExitQuote>(),[pending,setPending]=useState(false),[error,setError]=useState(''),request=useRef(0);
 const [recovery,setRecovery]=useState<LightningRecovery>(),[understood,setUnderstood]=useState(false);
 useEffect(()=>{setQuote(undefined);setPending(false);setError('');return()=>{request.current++;};},[service,outpoint]);
 useEffect(()=>{
  let stopped=false;setRecovery(undefined);setUnderstood(false);
  const refresh=async()=>{try{const saved=await service.getRecovery(outpoint);if(!stopped)setRecovery(saved);}catch(cause){if(!stopped)setError(errorText(cause));}};
  void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>{stopped=true;clearInterval(timer);};
 },[service,outpoint]);
 const load=async()=>{
  const id=++request.current;setPending(true);setError('');setQuote(undefined);
  try{const result=await service.quoteRecovery(outpoint);if(id===request.current)setQuote(result);}
  catch(cause){if(id===request.current)setError(errorText(cause));}
  finally{if(id===request.current)setPending(false);}
 };
 const act=async(action:()=>Promise<unknown>)=>{
  const id=++request.current;setPending(true);setError('');
  try{await action();const saved=await service.getRecovery(outpoint);if(id===request.current)setRecovery(saved);}
  catch(cause){if(id===request.current)setError(errorText(cause));}
  finally{if(id===request.current)setPending(false);}
 };
 const delay=quote?.vtxos[0]?.delay;
 return <><dt>Onchain recovery</dt><dd>
  <p className="stock-muted">Checking a quote looks up this payout and your onchain funding address with the Bitcoin explorer. The quote check signs and broadcasts nothing.</p>
  <button type="button" className="stock-ghost stock-mini" disabled={disabled||pending} onClick={()=>void load()}>{pending?'Checking recovery…':quote?'Refresh recovery quote':'Check onchain recovery'}</button>
  {error&&<p className="stock-blocked" role="alert">{error}</p>}
  {quote&&<div className="stock-address" role="status">
   <dl>
    <dt>Recovered after the sweep fee</dt><dd>{formatNumber(quote.totals.recoveredSats)} sats</dd>
    <dt>Total mining fees</dt><dd>{formatNumber(quote.totals.totalFeeSats)} sats at {formatNumber(quote.feeRate)} sat/vB</dd>
    <dt>Transactions</dt><dd>{quote.totals.txCount}</dd>
    {delay&&<><dt>Recovery delay</dt><dd>{formatNumber(delay.value)} {delay.type} after the payout confirms onchain</dd></>}
    <dt>Total onchain funding</dt><dd>{formatNumber(quote.totals.fundingRequiredSats)} sats</dd>
    <dt>Confirmed funds at quote time</dt><dd>{formatNumber(quote.currentBalanceSats)} sats</dd>
    <dt>Onchain funds needed</dt><dd>{formatNumber(quote.shortfallSats)} additional sats</dd>
    <dt>Onchain wallet address</dt><dd><div className="stock-copy"><code>{quote.fundingAddress}</code><CopyButton value={quote.fundingAddress}/></div><p className="stock-muted">Fee funding and recovered sats both arrive here.</p></dd>
   </dl>
   <p className="stock-muted">Viewing a quote leaves shielding active. Preparing recovery pauses shielding and signs a package saved in this browser; it broadcasts nothing. Starting recovery publishes the payout on Bitcoin; its delay starts at onchain confirmation. Unused fee funds stay in your onchain wallet.</p>
   {quote.validUntil!==undefined&&<p className="stock-muted">The underlying batch expires {new Date(quote.validUntil*1000).toLocaleString()}. Refresh the quote before starting recovery.</p>}
   {!recovery?.package&&<button type="button" className="stock-ghost stock-mini" disabled={disabled||pending||quote.shortfallSats>0} onClick={()=>void act(()=>service.prepareRecovery(outpoint,quote))}>Prepare recovery package</button>}
   {!recovery?.package&&quote.shortfallSats>0&&<p className="stock-muted">Fund this onchain wallet and refresh the quote before preparing recovery.</p>}
  </div>}
  {recovery&&<div className="stock-address" role="status">
   <p>{recovery.state==='complete'?'Recovery sweep confirmed on Bitcoin.':recovery.running?'Onchain recovery is running. Keep this page open.':recovery.package?'Package saved. Recovery is ready to start or resume.':'Recovery preparation is incomplete. Shielding is paused; refresh the quote and retry preparation.'}</p>
   {recovery.event?.status==='waiting_csv'&&<p>Waiting for {recovery.event.maturesAtHeight!==undefined?`Bitcoin block ${formatNumber(recovery.event.maturesAtHeight)}`:new Date(recovery.event.maturesAtTime!*1000).toLocaleString()} before the sweep.</p>}
   {recovery.error&&<p className="stock-blocked">{recovery.error}</p>}
   {recovery.package&&<>
    <p>{formatNumber(recovery.package.totals.recoveredSats)} sats after the sweep fee; {formatNumber(recovery.package.totals.totalFeeSats)} sats total mining fees. Destination: <code>{recovery.package.sweepAddress}</code>.</p>
    <p>Upfront funding: {formatNumber(recovery.package.totals.fundingRequiredSats)} sats. Recovery delay: {formatNumber(recovery.package.vtxos[0]!.delay!.value)} {recovery.package.vtxos[0]!.delay!.type} after the payout confirms onchain.</p>
    {recovery.package.validUntil!==undefined&&<p className="stock-muted">The underlying batch expires {new Date(recovery.package.validUntil*1000).toLocaleString()}; the operator may sweep after expiry.</p>}
    <a className="stock-ghost stock-mini" download={`shielded-exit-${outpoint.replace(':','-')}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(serializeExitPackage(recovery.package))}`}>Save recovery package</a>
    <p className="stock-muted">The package contains signed transactions, no private keys. Keep a copy: it can finish this recovery without your browser. It reveals the payout, fees and destination.</p>
    {recovery.state!=='complete'&&(recovery.running?<button type="button" className="stock-ghost stock-mini" disabled={pending} onClick={()=>void act(()=>service.pauseRecovery())}>Pause recovery</button>:<>
     <label><input type="checkbox" checked={understood} onChange={e=>setUnderstood(e.target.checked)}/>I understand starting recovery publishes this payout on Bitcoin and cannot undo transactions already broadcast. Its original delay still applies.</label>
     <button type="button" disabled={disabled||pending||!understood} onClick={()=>void act(()=>service.startRecovery(outpoint))}>Start or resume onchain recovery</button>
    </>)}
    <p className="stock-muted">Closing or pausing stops this browser's executor; it cannot recall transactions. Reopen this receipt to resume the saved package.</p>
   </>}
  </div>}
 </dd></>;
}
