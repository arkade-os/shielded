import {useEffect,useRef,useState,type ReactNode} from 'react';
import {NATIVE_RELEASE_ENDPOINT,type NativePlatform,type NativeRelease,type NativeReleasePackage} from '../../src/native-release.ts';
import {readNativeReleaseResponse} from '../../src/native-release-response.ts';
import {QrCode} from './wallet-qr.tsx';
import './native-downloads.css';

const repository='https://github.com/arkade-os/shielded';
const buildGuide=repository+'/blob/main/docs/NATIVE.md';
type PlatformGuide={platform:NativePlatform;name:string;architecture:string;description:string;steps:ReactNode[];reference:ReactNode};
const guides:PlatformGuide[]=[
 {platform:'windows-x86_64',name:'Windows',architecture:'x64',description:'An installer with WebView2 included. No separate browser runtime download.',steps:[
  <>Download the Windows installer below. Compare its SHA-256 with the checksum in this guide before opening it.</>,
  <>Open the <code>.exe</code> and follow the setup prompts. The installer includes the offline WebView2 runtime.</>,
  <>Launch Shielded from the Start menu. Wait for Tor to connect, then create a wallet or restore with your recovery phrase.</>,
 ],reference:<>This build has no publisher signature. If Windows blocks it, review <a href="https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation">Microsoft’s explanation of SmartScreen</a> before deciding whether to proceed.</>},
 {platform:'linux-x86_64',name:'Linux',architecture:'x64',description:'A Debian package or an AppImage. Your desktop needs an unlocked Secret Service keyring.',steps:[
  <>On Debian or Ubuntu, download the <code>.deb</code>, then open it in your software installer. Or, from its folder, run <code>sudo apt install ./</code> followed by the exact downloaded filename.</>,
  <>For the AppImage, download the file and allow it to run as a program in your file manager’s Permissions tab, then open it. If FUSE is missing, follow the <a href="https://docs.appimage.org/user-guide/troubleshooting/fuse.html">AppImage FUSE guide</a>.</>,
  <>Use a desktop with WebKitGTK 4.1, GTK 3 and D-Bus available. Start and unlock a Secret Service provider, such as GNOME Keyring or a compatible KWallet setup; Shielded cannot open its vault without one. See <a href="https://help.gnome.org/seahorse/keyring-unlock.html">GNOME’s keyring instructions</a>.</>,
  <>Open Shielded, wait for Tor, then create or restore your wallet. Keep the AppImage in a folder you can write to if you use that format.</>,
 ],reference:<>See the <a href="https://v2.tauri.app/distribute/debian/">Linux package requirements</a> and <a href="https://docs.appimage.org/introduction/quickstart.html">AppImage opening instructions</a>. The Debian installer resolves its declared system dependencies.</>},
 {platform:'macos-universal',name:'macOS',architecture:'Apple Silicon & Intel',description:'One universal app for both Mac architectures. Unsigned and not notarized.',steps:[
  <>Download the <code>.dmg</code>, open it, and drag Shielded into Applications. Alternatively, expand the app ZIP and move Shielded.app into Applications.</>,
  <>Open Shielded from Applications. macOS may block this unsigned, unnotarized build. If you trust this specific download, follow <a href="https://support.apple.com/en-us/102445">Apple’s instructions</a> for its per-app Privacy &amp; Security exception.</>,
  <>Wait for Tor to connect, then create or restore your wallet. macOS Keychain holds the wallet’s recovery secret on this device.</>,
 ],reference:<>Requires macOS 11 or later. Check the download and checksum before granting a per-app exception; keep the Mac’s security protections enabled.</>},
 {platform:'android-arm64',name:'Android',architecture:'ARM64',description:'Android app for ARM64 phones.',steps:[
  <>On your ARM64 phone, download the signed APK when offered. Older releases offer a debug APK instead. The unsigned release APK is for people who will sign it themselves; it cannot be installed as downloaded.</>,
  <>Open the APK from Downloads. If prompted, allow only the browser or file manager opening it to install unknown apps. Return to the installer and follow its prompts.</>,
  <>After installation, turn off that source’s installation permission. Open Shielded and wait for Tor before creating or restoring your wallet. Signed releases can download updates inside Shielded, through Tor unless you turn it off, and use Android’s installer without clearing wallet data.</>,
  <>Before an update, preserve verified recovery data and app data for unresolved swaps. The build runner’s development key can change, and Android can then refuse an in-place update. Keep the existing installation and its data while you resolve this.</>,
 ],reference:<>See <a href="https://support.google.com/pixelphone/answer/7391672?hl=en-GB">Google’s instructions for apps from other sources</a>. Names vary by device; leave Play Protect enabled.</>},
 {platform:'ios',name:'iOS',architecture:'iPhone & Simulator',description:'The device IPA needs your own Apple signing and provisioning. A Mac and Xcode are required.',steps:[
  <>The device <code>.ipa</code> is unsigned and cannot be tapped to install. Use your own Apple development certificate and a provisioning profile that includes your iPhone. A simulator ZIP cannot run on an iPhone.</>,
  <>For the supported Xcode route, get the matching source using the Source link below and follow the <a href={buildGuide+'#build'}>iOS build guide</a> on a Mac. Open the generated iOS project in Xcode and add your Apple Account in Settings.</>,
  <>In the app target’s Signing &amp; Capabilities, select your team and automatic signing. Connect and trust your iPhone, select it as the run destination, and enable Developer Mode when Xcode asks. Build and run on that device.</>,
  <>If you already have a signing workflow for the downloaded IPA, sign it for your registered device first, then install the signed app using Xcode or Apple Configurator. Follow <a href="https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices">Apple’s registered-device distribution guide</a>.</>,
 ],reference:<>For the separate simulator ZIP, extract the app on an Apple Silicon Mac with Xcode, start an iOS Simulator, and drag the app onto it. See <a href="https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices">Apple’s device and simulator guide</a>. These downloads are not distributed through TestFlight or the App Store.</>},
];

export function detectNativeDownloadPlatform(agent:{userAgent?:string;platform?:string;maxTouchPoints?:number}={}):NativePlatform|undefined{
 const ua=agent.userAgent??'',platform=agent.platform??'',description=ua+' '+platform;
 if(/android/i.test(ua))return 'android-arm64';
 if(/iPhone|iPad|iPod/i.test(description)||/^MacIntel$/i.test(platform)&&(agent.maxTouchPoints??0)>1)return 'ios';
 if(/Windows|Win32|Win64/i.test(description))return 'windows-x86_64';
 if(/Macintosh|Mac OS X|MacIntel|MacPPC/i.test(description))return 'macos-universal';
 if(/Linux/i.test(description)&&!/CrOS/i.test(ua))return 'linux-x86_64';
}
export function nativeDownloadPlatforms(platform:NativePlatform|undefined,showOthers:boolean):NativePlatform[]{
 const all=guides.map(guide=>guide.platform);
 return platform?showOthers?[platform,...all.filter(item=>item!==platform)]:[platform]:all;
}

export async function loadNativeDownloads(signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<NativeRelease|null>{
 try{return await readNativeReleaseResponse(await fetcher(NATIVE_RELEASE_ENDPOINT,{signal,cache:'no-store',credentials:'omit'}));}catch{return null;}
}
export type NativeDownloadsState={state:'loading'|'error';release:null}|{state:'ready';release:NativeRelease};
export function createNativeDownloadsLoader(onState:(state:NativeDownloadsState)=>void,fetcher:typeof fetch=fetch){
 type Attempt={controller:AbortController;promise:Promise<void>};
 let stopped=false,active:Attempt|undefined;
 function retry():Promise<void>{
  if(stopped)return Promise.resolve();
  if(active)return active.promise;
  const owner:Attempt={controller:new AbortController(),promise:Promise.resolve()};active=owner;
  let cancel=()=>{};
  const cancelled=new Promise<null>(resolve=>{cancel=()=>resolve(null);owner.controller.signal.addEventListener('abort',cancel,{once:true});});
  const timeout=setTimeout(()=>owner.controller.abort(),10_000);
  onState({state:'loading',release:null});
  owner.promise=Promise.race([loadNativeDownloads(owner.controller.signal,fetcher),cancelled]).then(release=>{
   clearTimeout(timeout);owner.controller.signal.removeEventListener('abort',cancel);
   if(stopped||active!==owner)return;
   active=undefined;
   onState(release?{state:'ready',release}:{state:'error',release:null});
  });
  return owner.promise;
 }
 return {retry,stop(){if(stopped)return;stopped=true;const previous=active;active=undefined;previous?.controller.abort();}};
}
export function nativePackageLabel(item:NativeReleasePackage):string{
 if(item.platform==='android-arm64')return item.requiresSigning?'Unsigned release APK':item.profile==='release'?'Signed APK':'Debug APK';
 if(item.platform==='ios')return item.requiresSigning?'Device IPA (signing required)':'Simulator ZIP';
 if(item.file.endsWith('.app.zip'))return 'App ZIP';
 if(item.file.endsWith('.AppImage'))return 'AppImage';
 if(item.file.endsWith('.dmg'))return 'DMG';
 if(item.file.endsWith('.deb'))return 'Debian package';
 return 'Windows installer';
}
const size=(bytes:number)=>`${(bytes/1_000_000).toLocaleString('en-US',{maximumFractionDigits:1})} MB`;

function DownloadQrButton({item,onOpen}:{item:NativeReleasePackage;onOpen:(item:NativeReleasePackage)=>void}){
 return <button type="button" className="nd-qr-button" aria-label={`Show QR code for ${guides.find(guide=>guide.platform===item.platform)!.name} ${nativePackageLabel(item)}`} aria-haspopup="dialog" onClick={()=>onOpen(item)}>QR</button>;
}
export function NativeDownloadQr({item,onClose}:{item:NativeReleasePackage;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{
  const modal=dialog.current!,previous=document.activeElement instanceof HTMLElement?document.activeElement:undefined,overflow=document.body.style.overflow;
  modal.showModal();document.body.style.overflow='hidden';
  return()=>{modal.close();document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus();};
 },[]);
 return <dialog ref={dialog} className="nd-qr-dialog" aria-labelledby="nd-qr-title" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}><div className="nd-qr-panel">
  <div className="nd-qr-heading"><h3 id="nd-qr-title">{guides.find(guide=>guide.platform===item.platform)!.name} · {nativePackageLabel(item)}</h3><button className="nd-qr-close" type="button" autoFocus aria-label="Close download QR code" onClick={onClose}>Close</button></div>
  <p>Scan with another device to download this file.</p><QrCode value={item.url} label={`Download QR code for ${nativePackageLabel(item)}`}/>
  <a className="nd-qr-url" href={item.url}>{item.url}</a>{item.requiresSigning&&<p className="nd-qr-signing">This package requires signing before installation.</p>}
 </div></dialog>;
}
function PackageLinks({packages,unavailable,onQr}:{packages:NativeReleasePackage[];unavailable:boolean;onQr:(item:NativeReleasePackage)=>void}){
 const signed=packages.find(item=>item.platform==='android-arm64'&&item.profile==='release'&&!item.requiresSigning),primary=signed?[signed]:packages.filter(item=>!(item.platform==='android-arm64'&&item.requiresSigning));
 return <div className="nd-package-links">{primary.length?primary.map(item=><div className="nd-binary" key={item.file}><a className="nd-download" href={item.url}><span>{nativePackageLabel(item)}</span><small>{size(item.bytes)}</small></a><DownloadQrButton item={item} onOpen={onQr}/></div>):<span className="nd-package-pending">{unavailable?'Download unavailable':'Checking packages…'}</span>}</div>;
}
export function NativeDownloadsContent({release,state=release?'ready':'loading',onRetry,platform}:{release:NativeRelease|null;state?:NativeDownloadsState['state'];onRetry?:()=>void;platform?:NativePlatform}){
 const [showOthers,setShowOthers]=useState(false),[qrPackage,setQrPackage]=useState<NativeReleasePackage>();
 const selected=platform&&guides.find(guide=>guide.platform===platform),platforms=nativeDownloadPlatforms(platform,showOthers);
 const source=repository+'/tree/'+(release?.commit??'main');
 return <section id="download" className="sh-section native-downloads" aria-labelledby="nd-title">
  <div className="nd-intro"><h2 id="nd-title">A private wallet.<br/>At home on your device.</h2><div><p>The same Shielded wallet, installed on Windows, Linux, Mac, Android or iPhone. Native apps connect through Tor and keep your recovery secret in the device vault.</p><p className="nd-testnet">Mutinynet test coins only. These are experimental builds.</p></div></div>
  <div className="nd-release" role="status" aria-busy={state==='loading'}>{release?<><p>Version {release.version}<span>Build {release.buildNumber}</span><a href={release.releaseUrl}>Release notes</a></p><p><a href={source}>Source <code>{release.commit.slice(0,12)}</code></a><time dateTime={release.publishedAt}>Published {release.publishedAt.slice(0,10)}</time></p></>:<><div className="nd-release-message"><p>{state==='error'?'Downloads are unavailable right now.':'Checking downloads…'}</p><p>The install guides are ready below. {state==='error'?'Try again or ':'You can also '}<a href={buildGuide}>build from source</a>.</p></div>{state==='error'&&<button className="nd-retry" type="button" onClick={onRetry}>Retry downloads</button>}</>}</div>
  <div className="nd-system-choice"><p>{selected?`Downloads for ${selected.name}`:'Choose your system'}</p>{platform&&<button type="button" aria-expanded={showOthers} aria-controls="nd-platforms" onClick={()=>setShowOthers(value=>!value)}>{showOthers?'Show fewer':'Other systems'}</button>}</div>
  <div className="nd-platforms" id="nd-platforms">{platforms.map(platform=>{const guide=guides.find(guide=>guide.platform===platform)!;
   const packages=release?.packages.filter(item=>item.platform===guide.platform)??[];
   if(guide.platform==='android-arm64'&&release?.androidUpdate)packages.unshift(release.androidUpdate);
   const description=guide.platform==='android-arm64'&&release?(release.androidUpdate?'Signed Android app with in-place updates over Tor by default.':'Debug APK signed with a development key.'):guide.description;
   return <article className="nd-platform" key={guide.platform} aria-labelledby={'nd-'+guide.platform}>
    <div className="nd-platform-heading"><h3 id={'nd-'+guide.platform}>{guide.name}<span>{guide.architecture}</span></h3><p>{description}</p></div>
    <PackageLinks packages={packages} unavailable={state==='error'} onQr={setQrPackage}/>
    <details className="nd-install"><summary>Install on {guide.name}<span aria-hidden="true">+</span></summary><div className="nd-guide"><ol>{guide.steps.map((step,index)=><li key={index}>{step}</li>)}</ol><p className="nd-reference">{guide.reference}</p>{packages.length>0&&<div className="nd-checks"><h4>Downloads &amp; checksums</h4><p>Compare the SHA-256 of your downloaded file before opening it. The checksum checks the file against this release; it is not a publisher signature.</p><p>{guide.platform==='windows-x86_64'?<>In PowerShell, run <code>Get-FileHash -Algorithm SHA256 "downloaded-file"</code>.</>:guide.platform==='macos-universal'||guide.platform==='ios'?<>On a Mac, run <code>shasum -a 256 "downloaded-file"</code> in Terminal.</>:<>On a Linux computer, run <code>sha256sum "downloaded-file"</code> in Terminal.</>} Replace <code>downloaded-file</code> with the file’s path, and compare the resulting hash with the value below.</p><ul>{packages.map(item=><li key={item.file}><div><a href={item.url}>{nativePackageLabel(item)}</a><DownloadQrButton item={item} onOpen={setQrPackage}/><span>{size(item.bytes)}{item.requiresSigning?' · Your signing required':''}</span><a href={source}>Source</a></div><span className="nd-filename">{item.file}</span><code>SHA-256 {item.sha256}</code></li>)}</ul></div>}</div></details>
   </article>;
  })}</div>
  {release?.environment?<div className="nd-reproducible"><p>Reproducible build inputs are pinned across every platform. Rebuild the source commit with the recorded toolchain and lockfiles, then compare the package SHA-256. Compare Android build output with the unsigned APK; reproducing its publisher signature also requires the private signing key.</p><p>Node <code>{release.environment.node}</code> · Rust <code>{release.environment.rust}</code> · npm lock <code>{release.environment.lockfileSha256.slice(0,12)}</code> · Cargo lock <code>{release.environment.rustLockfileSha256.slice(0,12)}</code></p></div>:release?<div className="nd-reproducible"><p>This older release predates reproducible build metadata. Its source commit and package checksums remain available below.</p></div>:null}
  <p className="nd-afterword">Before replacing an installation, save your recovery phrase securely and keep app data while swaps are unresolved. A recovery phrase alone does not preserve every pending swap. <a href={buildGuide}>Read the native wallet guide</a>.</p>
  {qrPackage&&<NativeDownloadQr item={qrPackage} onClose={()=>setQrPackage(undefined)}/>}
 </section>;
}
export default function NativeDownloads(){
 const [state,setState]=useState<NativeDownloadsState>({state:'loading',release:null}),loader=useRef<ReturnType<typeof createNativeDownloadsLoader>|null>(null);
 const [platform]=useState(()=>detectNativeDownloadPlatform(typeof window==='undefined'?undefined:navigator));
 useEffect(()=>{const owner=createNativeDownloadsLoader(setState);loader.current=owner;void owner.retry();return()=>{owner.stop();if(loader.current===owner)loader.current=null;};},[]);
 return <NativeDownloadsContent {...state} platform={platform} onRetry={()=>{void loader.current?.retry();}}/>;
}
