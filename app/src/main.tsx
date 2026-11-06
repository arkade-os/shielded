import React,{lazy,Suspense,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {registerAppCache} from './app-cache';
import ShieldedHome from './ShieldedHome';
const RollupWallet=lazy(()=>import('./RollupWallet'));
const Disclose=lazy(()=>import('./Disclose'));
const NativeWallet=lazy(()=>import('./NativeWallet'));
declare const __NATIVE_BUILD__:boolean;
import './fonts.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/space-mono/latin-400.css';
import '@fontsource/space-mono/latin-700.css';
import './style.css';
import './stock-wallet.css';
import './wallet-glass.css';

const path=location.pathname.replace(/\/+$/,'')||'/';
const loading=<div className="stock-page"><main className="stock-shell"><section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><h2>Loading wallet</h2></section></main></div>;
// Above every route, so each tab offers the update; the palette variables live on the route roots, hence .stock-update.
function UpdateBar(){
 const [apply,setApply]=useState<()=>void>();
 useEffect(()=>registerAppCache(next=>setApply(()=>next)),[]);
 return apply?<section className="stock-warning stock-update" role="status"><span>A new version of the app is ready.</span><button type="button" onClick={apply}>Update</button></section>:null;
}
// A route that throws would otherwise unmount UpdateBar too, and the next version is how a crashing release gets fixed.
class RouteBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<p>Something went wrong. Reload the page.</p>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(__NATIVE_BUILD__?<RouteBoundary><Suspense fallback={loading}><NativeWallet/></Suspense></RouteBoundary>:<React.StrictMode><UpdateBar/><RouteBoundary>{path==='/wallet'||path==='/rollup'||path==='/claim'?<Suspense fallback={loading}><RollupWallet/></Suspense>:path==='/verify'||path==='/watch'?<Suspense fallback={loading}><Disclose/></Suspense>:<ShieldedHome/>}</RouteBoundary></React.StrictMode>);
