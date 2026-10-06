import React,{lazy,Suspense} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import ShieldedHome from './ShieldedHome';
const NoncustodialWallet=lazy(()=>import('./NoncustodialWallet'));
const StockWallet=lazy(()=>import('./StockWallet'));
import './style.css';

const path=location.pathname.replace(/\/+$/,'')||'/';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{path==='/stock-wallet'?<Suspense fallback={<p>Loading wallet…</p>}><StockWallet/></Suspense>:path==='/wallet'?<Suspense fallback={<p>Loading wallet…</p>}><NoncustodialWallet/></Suspense>:path==='/lab'?<App/>:<ShieldedHome/>}</React.StrictMode>);
