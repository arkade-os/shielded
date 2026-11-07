import {useEffect,useState,type ReactNode} from 'react';
import {NATIVE_RELEASE_ENDPOINT,type NativePlatform,type NativeRelease,type NativeReleasePackage} from '../../src/native-release.ts';
import {readNativeReleaseResponse} from '../../src/native-release-response.ts';
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
 {platform:'android-arm64',name:'Android',architecture:'ARM64',description:'An installable test APK, signed with a development key. Updates may need extra care.',steps:[
  <>On your ARM64 phone, download the debug APK. The unsigned release APK is for people who will sign it themselves; it cannot be installed as downloaded.</>,
  <>Open the APK from Downloads. If prompted, allow only the browser or file manager opening it to install unknown apps. Return to the installer and follow its prompts.</>,
  <>After installation, turn off that source’s installation permission. Open Shielded and wait for Tor before creating or restoring your wallet.</>,
  <>Before an update, preserve verified recovery data and app data for unresolved swaps. The build runner’s development key can change, and Android can then refuse an in-place update. Keep the existing installation and its data while you resolve this.</>,
 ],reference:<>See <a href="https://support.google.com/pixelphone/answer/7391672?hl=en-GB">Google’s instructions for apps from other sources</a>. Names vary by device; leave Play Protect enabled.</>},
 {platform:'ios',name:'iOS',architecture:'iPhone & Simulator',description:'The device IPA needs your own Apple signing and provisioning. A Mac and Xcode are required.',steps:[
  <>The device <code>.ipa</code> is unsigned and cannot be tapped to install. Use your own Apple development certificate and a provisioning profile that includes your iPhone. A simulator ZIP cannot run on an iPhone.</>,
  <>For the supported Xcode route, get the matching source using the Source link below and follow the <a href={buildGuide+'#build'}>iOS build guide</a> on a Mac. Open the generated iOS project in Xcode and add your Apple Account in Settings.</>,
  <>In the app target’s Signing &amp; Capabilities, select your team and automatic signing. Connect and trust your iPhone, select it as the run destination, and enable Developer Mode when Xcode asks. Build and run on that device.</>,
  <>If you already have a signing workflow for the downloaded IPA, sign it for your registered device first, then install the signed app using Xcode or Apple Configurator. Follow <a href="https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices">Apple’s registered-device distribution guide</a>.</>,
 ],reference:<>For the separate simulator ZIP, extract the app on an Apple Silicon Mac with Xcode, start an iOS Simulator, and drag the app onto it. See <a href="https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices">Apple’s device and simulator guide</a>. These downloads are not distributed through TestFlight or the App Store.</>},
];

export async function loadNativeDownloads(signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<NativeRelease|null>{
 try{return await readNativeReleaseResponse(await fetcher(NATIVE_RELEASE_ENDPOINT,{signal,cache:'no-store',credentials:'omit'}));}catch{return null;}
}
export function nativePackageLabel(item:NativeReleasePackage):string{
 if(item.platform==='android-arm64')return item.requiresSigning?'Unsigned release APK':'Debug APK';
 if(item.platform==='ios')return item.requiresSigning?'Device IPA (signing required)':'Simulator ZIP';
 if(item.file.endsWith('.app.zip'))return 'App ZIP';
 if(item.file.endsWith('.AppImage'))return 'AppImage';
 if(item.file.endsWith('.dmg'))return 'DMG';
 if(item.file.endsWith('.deb'))return 'Debian package';
 return 'Windows installer';
}
const size=(bytes:number)=>`${(bytes/1_000_000).toLocaleString('en-US',{maximumFractionDigits:1})} MB`;

function PackageLinks({packages}:{packages:NativeReleasePackage[]}){
 return <div className="nd-package-links">{packages.length?packages.filter(item=>!(item.platform==='android-arm64'&&item.requiresSigning)).map(item=><a key={item.file} className="nd-download" href={item.url}><span>{nativePackageLabel(item)}</span><small>{size(item.bytes)}</small></a>):<span className="nd-package-pending">Package pending</span>}</div>;
}
export function NativeDownloadsContent({release}:{release:NativeRelease|null}){
 const source=repository+'/tree/'+(release?.commit??'main');
 return <section id="download" className="sh-section native-downloads" aria-labelledby="nd-title">
  <div className="nd-intro"><h2 id="nd-title">A private wallet.<br/>At home on your device.</h2><div><p>The same Shielded wallet, installed on Windows, Linux, Mac, Android or iPhone. Native apps connect through Tor and keep your recovery secret in the device vault.</p><p className="nd-testnet">Mutinynet test coins only. These are experimental builds.</p></div></div>
  <div className="nd-release" role="status">{release?<><p>Version {release.version}<span>Build {release.buildNumber}</span><a href={release.releaseUrl}>Release notes</a></p><p><a href={source}>Source <code>{release.commit.slice(0,12)}</code></a><time dateTime={release.publishedAt}>Published {release.publishedAt.slice(0,10)}</time></p></>:<><p>Downloads are being prepared.</p><p>The install guides are ready below. You can also <a href={buildGuide}>build from source</a>.</p></>}</div>
  <div className="nd-platforms">{guides.map(guide=>{
   const packages=release?.packages.filter(item=>item.platform===guide.platform)??[];
   return <article className="nd-platform" key={guide.platform} aria-labelledby={'nd-'+guide.platform}>
    <div className="nd-platform-heading"><h3 id={'nd-'+guide.platform}>{guide.name}<span>{guide.architecture}</span></h3><p>{guide.description}</p></div>
    <PackageLinks packages={packages}/>
    <details className="nd-install"><summary>Install on {guide.name}<span aria-hidden="true">+</span></summary><div className="nd-guide"><ol>{guide.steps.map((step,index)=><li key={index}>{step}</li>)}</ol><p className="nd-reference">{guide.reference}</p>{packages.length>0&&<div className="nd-checks"><h4>Downloads &amp; checksums</h4><p>Compare the SHA-256 of your downloaded file before opening it. The checksum checks the file against this release; it is not a publisher signature.</p><p>{guide.platform==='windows-x86_64'?<>In PowerShell, run <code>Get-FileHash -Algorithm SHA256 "downloaded-file"</code>.</>:guide.platform==='macos-universal'||guide.platform==='ios'?<>On a Mac, run <code>shasum -a 256 "downloaded-file"</code> in Terminal.</>:<>On a Linux computer, run <code>sha256sum "downloaded-file"</code> in Terminal.</>} Replace <code>downloaded-file</code> with the file’s path, and compare the resulting hash with the value below.</p><ul>{packages.map(item=><li key={item.file}><div><a href={item.url}>{nativePackageLabel(item)}</a><span>{size(item.bytes)}{item.requiresSigning?' · Your signing required':''}</span><a href={source}>Source</a></div><span className="nd-filename">{item.file}</span><code>SHA-256 {item.sha256}</code></li>)}</ul></div>}</div></details>
   </article>;
  })}</div>
  <p className="nd-afterword">Before replacing an installation, save your recovery phrase securely and keep app data while swaps are unresolved. A recovery phrase alone does not preserve every pending swap. <a href={buildGuide}>Read the native wallet guide</a>.</p>
 </section>;
}
export default function NativeDownloads(){
 const [release,setRelease]=useState<NativeRelease|null>(null);
 useEffect(()=>{const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10_000);void loadNativeDownloads(controller.signal).then(value=>{if(!controller.signal.aborted)setRelease(value);}).finally(()=>clearTimeout(timeout));return()=>{clearTimeout(timeout);controller.abort();};},[]);
 return <NativeDownloadsContent release={release}/>;
}
