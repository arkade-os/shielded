import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';
import {Children,isValidElement,type ReactNode} from 'react';
import {openPaymentRequest} from '../app/src/rollup-client.ts';

const key='__shieldedCameraTest';
const state=globalThis as typeof globalThis&{[key]:Harness};
const reactMock=`const get=()=>globalThis.${key};
export const useMemo=fn=>fn();
export const useEffect=fn=>{get().effect=fn;};
export const useRef=value=>{const h=get();return h.refs[h.refCursor++]??{current:value};};
export const useState=value=>{const h=get();return [h.problem,v=>{h.problem=v;h.problemSet.resolve();}];};`;
const cameraMock=`const get=()=>globalThis.${key};
export const rearCamera=player=>{const h=get();h.player=player;h.acquiring.resolve();return h.acquisition.promise;};
export class QRCanvas{constructor(){if(get().failure==='canvas')throw Error('canvas failed');}}
export const frameLoop=callback=>{const h=get();if(h.failure==='loop')throw Error('loop failed');h.frame=callback;h.started.resolve();return ()=>{h.cancelCalls++;};};`;
const moduleUrl=(source:string)=>'data:text/javascript,'+encodeURIComponent(source);
registerHooks({resolve:(specifier,context,next)=>{
 if(context.parentURL?.includes('/app/src/wallet-qr.tsx')){
  if(specifier==='react')return {url:moduleUrl(reactMock),shortCircuit:true};
  if(specifier==='qr/dom.js')return {url:moduleUrl(cameraMock),shortCircuit:true};
 }
 return next(specifier,context);
}});
const {Scanner}=await import('../app/src/wallet-qr.tsx');
function deferred<T=void>(){
 let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(reason:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
type Camera={stop:()=>void;readFrame:()=>Promise<string|undefined>};
type Signal=ReturnType<typeof deferred<void>>;
type Harness={
 refs:{current:unknown}[];refCursor:number;effect?:()=>()=>void;cleanup:()=>void;problem:string;
 problemSet:Signal;acquiring:Signal;started:Signal;stopped:Signal;
 acquisition:ReturnType<typeof deferred<Camera>>;reading:ReturnType<typeof deferred<string|undefined>>;
 failure?:'canvas'|'loop';player?:unknown;frame?:()=>void;stopCalls:number;cancelCalls:number;results:string[];
 camera:Camera;render:()=>ReactNode;
};
function mount(failure?:Harness['failure']):Harness{
 const h={refs:[{current:{showModal(){}}},{current:{}},{current:undefined}],refCursor:0,problem:'',failure,
  problemSet:deferred(),acquiring:deferred(),started:deferred(),stopped:deferred(),acquisition:deferred<Camera>(),reading:deferred<string|undefined>(),
  stopCalls:0,cancelCalls:0,results:[],cleanup:()=>{}} as unknown as Harness;
 h.camera={stop:()=>{h.stopCalls++;h.stopped.resolve();},readFrame:()=>h.reading.promise};
 h.render=()=>{h.refCursor=0;return Scanner({onResult:value=>h.results.push(value),onClose:()=>h.cleanup()});};
 state[key]=h;h.render();assert.ok(h.effect);h.cleanup=h.effect();return h;
}
function status(node:ReactNode):ReactNode{
 for(const child of Children.toArray(node))if(isValidElement<{children?:ReactNode;role?:string}>(child)){
  if(child.props.role==='status')return child.props.children;
  const result=status(child.props.children);if(result!==undefined)return result;
 }
}

test('a camera granted after the scanner closes is stopped without starting a frame loop',async()=>{
 const h=mount();await h.acquiring.promise;h.cleanup();h.acquisition.resolve(h.camera);await h.stopped.promise;
 assert.equal(h.stopCalls,1);assert.equal(h.frame,undefined);assert.deepEqual(h.results,[]);
});

for(const failure of ['canvas','loop'] as const)test(`a ${failure} initialization failure stops the acquired camera before closing`,async()=>{
 const h=mount(failure);await h.acquiring.promise;h.acquisition.resolve(h.camera);await h.problemSet.promise;
 assert.equal(h.stopCalls,1);
 assert.equal(status(h.render()),'The camera did not start. Paste the code instead.');
 h.cleanup();assert.equal(h.stopCalls,1);assert.deepEqual(h.results,[]);
});

test('permission denial remains visible while the scanner is mounted',async()=>{
 const h=mount();await h.acquiring.promise;h.acquisition.reject({name:'NotAllowedError'});await h.problemSet.promise;
 assert.equal(status(h.render()),'Shielded may not use the camera. Allow it in your browser or app settings, or paste the code instead.');
 assert.equal(h.stopCalls,0);assert.equal(h.frame,undefined);h.cleanup();
});

test('closing an active scanner stops its frame loop and camera',async()=>{
 const h=mount();await h.acquiring.promise;h.acquisition.resolve(h.camera);await h.started.promise;h.cleanup();
 assert.equal(h.stopCalls,1);assert.equal(h.cancelCalls,1);assert.deepEqual(h.results,[]);
});

test('a decoded frame arriving after close cannot deliver a payment target',async()=>{
 const h=mount();await h.acquiring.promise;h.acquisition.resolve(h.camera);await h.started.promise;assert.ok(h.frame);
 h.frame();h.cleanup();h.reading.resolve('lightning:stale');await h.reading.promise;
 assert.deepEqual(h.results,[]);assert.equal(h.stopCalls,1);assert.equal(h.cancelCalls,1);
});

test('a successful scan stops resources and delivers its result once',async()=>{
 const h=mount();await h.acquiring.promise;h.acquisition.resolve(h.camera);await h.started.promise;assert.ok(h.frame);
 h.frame();h.reading.resolve('lightning:invoice');await h.stopped.promise;
 assert.equal(h.stopCalls,1);assert.equal(h.cancelCalls,1);assert.deepEqual(h.results,['lightning:invoice']);
 h.cleanup();assert.equal(h.stopCalls,1);assert.equal(h.cancelCalls,1);
});

test('an incoming payment closes the active camera before filling Send and ignores its pending frame',async()=>{
 const h=mount(),events:string[]=[];await h.acquiring.promise;h.acquisition.resolve(h.camera);await h.started.promise;
 h.frame!();
 openPaymentRequest({docked:true,closeScanner:()=>{events.push('close');h.cleanup();},openPanel:()=>events.push('send'),selectTab:()=>events.push('tab'),fill:()=>events.push('lightning:new-request')});
 h.reading.resolve('lightning:old-frame');await h.reading.promise;await Promise.resolve();
 assert.deepEqual(events,['close','send','lightning:new-request']);assert.deepEqual(h.results,[]);
 assert.equal(h.stopCalls,1);assert.equal(h.cancelCalls,1);
});

test('the scanner asks its camera for an uncropped standard mode, not the screen\'s own aspect',async()=>{
 const {readFileSync}=await import('node:fs');
 assert.match(readFileSync(new URL('../app/src/wallet-qr.tsx',import.meta.url),'utf8'),/getVideoTracks\(\)\[0\]\?\.applyConstraints\(\{width:\{ideal:1920\},height:\{ideal:1080\},resizeMode:'none'\}/);
});
