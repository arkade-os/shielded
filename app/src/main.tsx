import React,{lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import ShieldedHome from './ShieldedHome';
const RollupWallet=lazy(()=>import('./RollupWallet'));
const Disclose=lazy(()=>import('./Disclose'));
import './style.css';
import './stock-wallet.css';

const path=location.pathname.replace(/\/+$/,'')||'/';
const loading=<div className="stock-page"><main className="stock-shell"><section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><h2>Loading wallet</h2></section></main></div>;
createRoot(document.getElementById('root')!).render(<React.StrictMode>{path==='/wallet'||path==='/rollup'?<Suspense fallback={loading}><RollupWallet/></Suspense>:path==='/verify'||path==='/watch'?<Suspense fallback={loading}><Disclose/></Suspense>:<ShieldedHome/>}</React.StrictMode>);
