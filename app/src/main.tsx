import React,{lazy,Suspense} from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
const NoncustodialWallet=lazy(()=>import('./NoncustodialWallet'));
const StockWallet=lazy(()=>import('./StockWallet'));
import './style.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname==='/stock-wallet'?<Suspense fallback={<p>Loading stock wallet…</p>}><StockWallet/></Suspense>:location.pathname==='/wallet'?<Suspense fallback={<p>Loading wallet…</p>}><NoncustodialWallet/></Suspense>:<App/>}</React.StrictMode>);
