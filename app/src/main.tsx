import React,{lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import ShieldedHome from './ShieldedHome';
const NoncustodialWallet=lazy(()=>import('./NoncustodialWallet'));
const StockWallet=lazy(()=>import('./StockWallet'));
const RollupWallet=lazy(()=>import('./RollupWallet'));
import './style.css';
import './stock-wallet.css';

const path=location.pathname.replace(/\/+$/,'')||'/';
const loading=<div className="stock-page"><main className="stock-shell"><section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><h2>Loading wallet</h2></section></main></div>;
createRoot(document.getElementById('root')!).render(<React.StrictMode>{path==='/rollup'?<Suspense fallback={loading}><RollupWallet/></Suspense>:path==='/stock-wallet'?<Suspense fallback={<div className="stock-page"><main className="stock-shell"><section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><h2>Loading wallet</h2></section></main></div>}><StockWallet/></Suspense>:path==='/wallet'?<Suspense fallback={<p>Loading wallet…</p>}><NoncustodialWallet/></Suspense>:path==='/lab'?<App/>:<ShieldedHome/>}</React.StrictMode>);
