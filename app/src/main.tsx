import React,{lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import {AppUpdatesProvider,NativeUpdateLink} from './AppUpdates.tsx';
import ShieldedHome from './ShieldedHome';
import WalletOnboarding from './WalletOnboarding';
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
import './app-updates.css';

const path=location.pathname.replace(/\/+$/,'')||'/';
const loading=<div className="stock-page"><main className="stock-shell"><section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><h2>Loading wallet</h2></section></main></div>;
const walletLoading=<WalletOnboarding transport="browser" setup={false} busy phase="Opening your wallet" error="" phrase="" onPhraseChange={()=>{}} onCreate={()=>{}} onRestore={()=>{}} onReconnect={()=>{}}/>;
const nativeLoading=<WalletOnboarding transport="tor" setup={false} busy phase="Opening your wallet" error="" phrase="" onPhraseChange={()=>{}} onCreate={()=>{}} onRestore={()=>{}} onReconnect={()=>{}}/>;
class RouteBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<><p>Something went wrong. Reload the page.</p><div className="app-update-fallback"><NativeUpdateLink/></div></>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(<AppUpdatesProvider>{__NATIVE_BUILD__?<RouteBoundary><Suspense fallback={nativeLoading}><NativeWallet/></Suspense></RouteBoundary>:<React.StrictMode><RouteBoundary>{path==='/wallet'||path==='/rollup'||path==='/claim'?<Suspense fallback={walletLoading}><RollupWallet/></Suspense>:path==='/verify'||path==='/watch'?<Suspense fallback={loading}><Disclose/></Suspense>:<ShieldedHome downloadOnly={path==='/download'}/>}</RouteBoundary></React.StrictMode>}</AppUpdatesProvider>);
