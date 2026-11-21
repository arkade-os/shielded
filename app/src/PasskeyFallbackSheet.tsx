import './wallet-onboarding.css';

const BROWSER='Your passkey was saved, but it can’t make this wallet’s keys on this device. Shielded can make a recovery phrase instead and keep it in this browser, locked by this passkey. This passkey won’t restore the wallet anywhere else: only the recovery phrase can. Back it up next.';
// Focus goes to the dialog, not its first button, so a stray Enter cannot choose Continue.
const openModal=(dialog:HTMLDialogElement|null)=>{if(dialog&&!dialog.open){dialog.showModal();dialog.focus();}};
export const deviceLockName=(platform:string)=>platform==='windows'?'this computer’s Windows Hello':'this phone’s fingerprint or PIN';

export default function PasskeyFallbackSheet(p:{platform:'browser'|'android'|'windows';windowsWarning:boolean;passkeyName:string;busy:boolean;onContinue():void;onCancel():void}){
 const lock=deviceLockName(p.platform);
 return <dialog ref={openModal} className="passkey-fallback" tabIndex={-1} aria-labelledby="passkey-fallback-text" onCancel={event=>{event.preventDefault();if(!p.busy)p.onCancel();}}>
  <p id="passkey-fallback-text">{p.platform==='browser'?BROWSER:`Your passkey was saved, but it can’t make this wallet’s keys on this device. Shielded can make a recovery phrase instead and lock it with ${lock}. This passkey isn’t needed for it; you can delete it (“${p.passkeyName}”). Keep a screen lock on this device, and back up the recovery phrase next: it’s the only way to restore this wallet.`}</p>
  {p.windowsWarning&&<p className="wallet-onboarding-error">On Windows, any program running on this computer can read what this passkey locks, without asking you. Only continue if you trust the programs on this computer, and back up the recovery phrase.</p>}
  <div className="wallet-onboarding-actions"><button className="wallet-onboarding-primary" type="button" disabled={p.busy} onClick={p.onContinue}>Continue</button><button className="wallet-onboarding-secondary" type="button" disabled={p.busy} onClick={p.onCancel}>Cancel</button></div>
 </dialog>;
}
