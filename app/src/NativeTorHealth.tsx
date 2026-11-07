import type {NativeTorHealthState} from './native-tor-monitor.ts';
import './native-tor-health.css';

export const initialTorHealth:NativeTorHealthState={status:{phase:'idle',generation:0},check:'idle'};

export default function NativeTorHealth({health=initialTorHealth,tone='light'}:{health?:NativeTorHealthState;tone?:'light'|'dark'}){
 const {status,check,checkedAt,latencyMs}=health;
 const ready=status.phase==='ready',connected=ready&&check==='ok';
 const label=status.phase==='paused'?'Tor paused':status.phase==='error'?'Tor unavailable':status.phase==='bootstrapping'?'Connecting to Tor':ready?(connected?'Tor connected':check==='failed'?'Tor check failed':check==='checking'?'Checking Tor':'Tor ready'):'Starting Tor';
 const state=connected?'connected':status.phase==='error'||ready&&check==='failed'?'error':status.phase==='paused'?'paused':'connecting';
 const progress=status.phase==='bootstrapping'&&status.progress&&/^\d{1,3}%$/.test(status.progress)?status.progress:undefined;
 const detail=status.phase==='paused'?'The private connection is paused. Unlock the wallet to reconnect.':status.phase==='error'?(status.error||'Tor could not start. Reconnect to try again.'):ready&&check==='failed'?'The latest connection check through Tor failed. Your wallet never falls back to a direct connection.':connected?'A recent connection to the wallet service succeeded through Tor.':ready?'Tor is ready. Checking the connection to the wallet service.':'Tor starts automatically and keeps wallet traffic private while it connects.';
 return <details className="native-tor-health" data-tone={tone} data-health={state}>
  <summary aria-label={`Tor connection: ${label}`}><span className="native-tor-dot" aria-hidden="true"/><span role="status" aria-live="polite">{label}{progress&&<span className="native-tor-percent"> {progress}</span>}</span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m5 6 3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></summary>
  <div className="native-tor-panel"><strong>{label}</strong><p>{detail}</p>
   {progress&&<progress max={100} value={Math.min(100,parseInt(progress,10))} aria-label="Tor bootstrap progress"/>}
   {ready&&checkedAt&&<p className="native-tor-checked">Last checked {new Date(checkedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'})}{latencyMs!==undefined?` · ${(latencyMs/1000).toFixed(1)}s`:''}</p>}
   {ready&&check==='failed'&&health.error&&<p className="native-tor-problem">{health.error}</p>}
   <p className="native-tor-privacy">Separate Tor scopes protect unrelated wallet items. Repeated identifiers and timing can still reveal links. Wallet services may be unavailable even when Tor is connected.</p>
  </div>
 </details>;
}
