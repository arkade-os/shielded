import React,{lazy,Suspense} from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
const NoncustodialWallet=lazy(()=>import('./NoncustodialWallet'));
import './style.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname==='/wallet'?<Suspense fallback={<p>Loading wallet…</p>}><NoncustodialWallet/></Suspense>:<App/>}</React.StrictMode>);
