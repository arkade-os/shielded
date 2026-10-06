import React,{lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import ShieldedHome from './ShieldedHome';
const NoncustodialWallet=lazy(()=>import('./NoncustodialWallet'));
const StockWallet=lazy(()=>import('./StockWallet'));
import './style.css';

const path=location.pathname.replace(/\/+$/,'')||'/';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{path==='/stock-wallet'?<Suspense fallback={<main className="stock-shell"><section className="stock-card stock-loading" aria-busy="true"><span className="stock-spinner" aria-hidden="true"/><h2>Loading wallet</h2></section></main>}><StockWallet/></Suspense>:path==='/wallet'?<Suspense fallback={<p>Loading wallet…</p>}><NoncustodialWallet/></Suspense>:path==='/lab'?<App/>:<ShieldedHome/>}</React.StrictMode>);
