import {NATIVE_RELEASE_ENDPOINT,NATIVE_RELEASE_ORIGIN,type NativeRelease,type NativePlatform} from '../../src/native-release.ts';
import {readNativeReleaseResponse} from '../../src/native-release-response.ts';
import type {NativeStatus} from '../../src/native/transport.ts';

export interface NativeBuildIdentity {commit:string;buildNumber:number;platform:string;channel:string;network:string}
interface UpdateNetwork {status():Promise<NativeStatus>;subscribe(listener:(status:NativeStatus)=>void):()=>void;fetch:typeof fetch}
export function isNewerNativeRelease(release:NativeRelease,identity:NativeBuildIdentity):boolean{
 return Number.isSafeInteger(identity.buildNumber)&&identity.buildNumber>0&&/^[a-f0-9]{40}$/.test(identity.commit)
  &&release.buildNumber>identity.buildNumber&&release.commit!==identity.commit&&release.channel===identity.channel&&release.network===identity.network
  &&release.packages.some(item=>item.platform===identity.platform as NativePlatform);
}

export function createNativeUpdateMonitor(network:UpdateNetwork,identity:NativeBuildIdentity,onUpdate:(release:NativeRelease|undefined)=>void,isVisible:()=>boolean){
 type Probe={controller:AbortController;generation:number;deadline?:ReturnType<typeof setTimeout>};
 let status:NativeStatus={phase:'idle',generation:0},stopped=false,revision=0,probe:Probe|undefined,scheduled:ReturnType<typeof setTimeout>|undefined;
 const invalidate=()=>{clearTimeout(scheduled);scheduled=undefined;const previous=probe;probe=undefined;if(previous){clearTimeout(previous.deadline);previous.controller.abort();}if(!stopped)onUpdate(undefined);};
 const known=Number.isSafeInteger(identity.buildNumber)&&identity.buildNumber>0&&/^[a-f0-9]{40}$/.test(identity.commit)&&['windows-x86_64','linux-x86_64','macos-universal','android-arm64','ios'].includes(identity.platform);
 function check(){
  if(stopped||!known||!isVisible()||status.phase!=='ready'||probe)return;
  clearTimeout(scheduled);scheduled=undefined;
  const owner:Probe={controller:new AbortController(),generation:status.generation};probe=owner;
  let abort=()=>{};
  const timeout=new Promise<never>((_,reject)=>{
   abort=()=>reject(owner.controller.signal.reason??new Error('Native release check cancelled'));owner.controller.signal.addEventListener('abort',abort,{once:true});
   owner.deadline=setTimeout(()=>{reject(new Error('Native release check timed out'));owner.controller.abort();},10_000);
  });
  const request=async()=>readNativeReleaseResponse(await network.fetch(NATIVE_RELEASE_ORIGIN+NATIVE_RELEASE_ENDPOINT,{method:'GET',signal:owner.controller.signal,credentials:'omit',cache:'no-store',redirect:'error',headers:{Accept:'application/json'}}));
  const finish=(release?:NativeRelease)=>{
   clearTimeout(owner.deadline);owner.controller.signal.removeEventListener('abort',abort);
   if(stopped||probe!==owner)return;
   probe=undefined;
   if(!isVisible()||status.phase!=='ready'||status.generation!==owner.generation)return;
   onUpdate(release&&isNewerNativeRelease(release,identity)?release:undefined);
   scheduled=setTimeout(()=>{scheduled=undefined;check();},30*60_000);
  };
  void Promise.race([request(),timeout]).then(finish,()=>finish());
 }
 const accept=(next:NativeStatus)=>{
  if(stopped||!Number.isSafeInteger(next.generation)||next.generation<status.generation)return;
  revision++;
  const changed=next.generation!==status.generation||next.phase!=='ready'||status.phase!=='ready';status=next;
  if(changed)invalidate();
  if(isVisible()&&status.phase==='ready'&&!scheduled)check();
 };
 const refresh=()=>{
  const captured=revision;
  void network.status().then(next=>{if(!stopped&&captured===revision)accept(next);},()=>{});
 };
 const unsubscribe=network.subscribe(accept);refresh();
 return {check,visibilityChanged(){revision++;invalidate();if(!stopped&&isVisible())refresh();},stop(){if(stopped)return;stopped=true;revision++;unsubscribe();invalidate();}};
}
