import type {ReactNode} from 'react';
import {EngravedShield} from './WalletOnboarding.tsx';

export default function WalletEntrance({children,enabled=true}:{children:ReactNode;enabled?:boolean}){
 if(!enabled)return <>{children}</>;
 return <>{children}<div className="wallet-entrance-handoff" aria-hidden="true"><div className="wallet-entrance-veil"/><span className="wallet-entrance-ring"/><EngravedShield/></div></>;
}
