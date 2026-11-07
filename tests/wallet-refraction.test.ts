import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import * as refraction from '../app/src/wallet-refraction.ts';

function environment(t:TestContext){
 const original=new Map<string,PropertyDescriptor|undefined>();
 const set=(key:string,value:unknown)=>{original.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 const flags={canvasError:false,imageError:false,srcError:false,supported:true},cleanups:(()=>void)[]=[],frames=new Map<number,FrameRequestCallback>();
 const bounds={width:400,height:600},windowEvents=new EventTarget(),agent={userAgent:'Mozilla/5.0 Chrome/140.0.0.0'};
 const preference=Object.assign(new EventTarget(),{matches:false});
 let nextFrame=0;
 class Observer{
  disconnected=false;
  constructor(readonly callback:()=>void){observers.push(this);}
  observe(){}disconnect(){this.disconnected=true;}
 }
 class Image{
  onload:((event:Event)=>void)|null=null;onerror:((event:Event)=>void)|null=null;
  private value='';
  constructor(){if(flags.imageError)throw new Error('image unavailable');images.push(this);}
  set src(value:string){if(flags.srcError)throw new Error('image rejected');this.value=value;}
  get src(){return this.value;}
 }
 const observers:Observer[]=[],images:Image[]=[];
 const bitmaps:{width:number;height:number;data:Uint8ClampedArray}[]=[];
 set('document',{createElement:()=>({width:0,height:0,getContext:()=>({createImageData:(width:number,height:number)=>{const image={width,height,data:new Uint8ClampedArray(width*height*4)};bitmaps.push(image);return image;},putImageData:()=>{}}),toDataURL:()=>{if(flags.canvasError)throw new Error('canvas encoding failed');return 'data:image/png;base64,eA==';}})});
 set('CSS',{supports:()=>flags.supported});set('navigator',agent);set('window',windowEvents);set('matchMedia',()=>preference);
 set('ResizeObserver',Observer);set('Image',Image);
 set('requestAnimationFrame',(callback:FrameRequestCallback)=>{const id=++nextFrame;frames.set(id,callback);return id;});
 set('cancelAnimationFrame',(id:number)=>{frames.delete(id);});
 const node={getBoundingClientRect:()=>({...bounds})} as HTMLElement;
 const observe=(publish:(map:refraction.RefractionFrame|undefined)=>void)=>{const stop=refraction.observeRefraction(node,publish);cleanups.push(stop);return stop;};
 const flush=()=>{const current=[...frames.values()];frames.clear();for(const callback of current)callback(0);};
 const resize=(width:number,height:number)=>{Object.assign(bounds,{width,height});for(const observer of observers)if(!observer.disconnected)observer.callback();};
 const transparency=(reduced:boolean)=>{preference.matches=reduced;preference.dispatchEvent(new Event('change'));};
 t.after(()=>{for(const stop of cleanups)stop();for(const [key,value] of original)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);});
 return {bitmaps,flags,frames,images,observers,agent,preference,observe,flush,resize,transparency,windowEvents};
}

test('the original map keeps a neutral center and opposing edge normals',t=>{
 const {bitmaps}=environment(t);
 assert.ok(refraction.refractionMap(96,48));
 const image=bitmaps[0]!,pixel=(x:number,y:number)=>image.data.slice(4*(y*image.width+x),4*(y*image.width+x)+4);
 assert.deepEqual([...pixel(48,24)],[128,128,128,255]);
 assert.ok(pixel(0,24)[0]!>128&&pixel(95,24)[0]!<128);
 assert.deepEqual([image.width,image.height],[96,48]);
});

test('a glass surface publishes only decoded maps at its measured size',t=>{
 const env=environment(t),maps:(refraction.RefractionFrame|undefined)[]=[];
 env.observe(map=>maps.push(map));env.flush();
 assert.equal(maps.at(-1),undefined);
 assert.equal(env.images.length,1);
 env.images[0]!.onload!(new Event('load'));
 assert.deepEqual(maps.at(-1),{width:400,height:600,href:'data:image/png;base64,eA=='});
 assert.ok(env.bitmaps[0]!.width*env.bitmaps[0]!.height<=65536);
});

test('a resize fences the old decoder before the next animation frame',t=>{
 const env=environment(t),maps:(refraction.RefractionFrame|undefined)[]=[];
 env.observe(map=>maps.push(map));env.flush();
 const late=env.images[0]!.onload!;
 env.resize(500,700);late(new Event('load'));
 assert.equal(maps.at(-1),undefined,'an old-size image is never published during a pending resize');
 env.flush();env.images.at(-1)!.onload!(new Event('load'));
 assert.equal(maps.at(-1)?.width,500);
});

test('hidden surfaces recover at the same size and retired callbacks stay silent',t=>{
 const env=environment(t),maps:(refraction.RefractionFrame|undefined)[]=[];
 const stop=env.observe(map=>maps.push(map));env.flush();
 const late=env.images[0]!.onload!;
 env.resize(0,0);env.flush();late(new Event('load'));
 assert.equal(maps.at(-1),undefined);
 env.resize(400,600);env.flush();
 assert.equal(env.images.length,2);
 const final=env.images[1]!.onload!;final(new Event('load'));
 assert.equal(maps.at(-1)?.height,600);
 stop();const count=maps.length;final(new Event('load'));late(new Event('load'));
 env.windowEvents.dispatchEvent(new Event('resize'));env.observers[0]!.callback();env.flush();
 assert.equal(maps.length,count);assert.equal(env.frames.size,0);assert.equal(env.observers[0]!.disconnected,true);
});

test('canvas and image decoding failures stay on fallback and can retry',t=>{
 const env=environment(t),maps:(refraction.RefractionFrame|undefined)[]=[];
 env.flags.canvasError=true;env.observe(map=>maps.push(map));assert.doesNotThrow(env.flush);
 assert.equal(env.images.length,0);assert.equal(maps.at(-1),undefined);
 env.flags.canvasError=false;env.resize(400,600);env.flush();env.images[0]!.onerror!(new Event('error'));
 assert.equal(maps.at(-1),undefined);
 env.resize(400,600);env.flush();env.images[1]!.onload!(new Event('load'));
 assert.ok(maps.at(-1));
});

test('image construction and source failures do not escape the frame callback',t=>{
 const env=environment(t),maps:(refraction.RefractionFrame|undefined)[]=[];
 env.flags.imageError=true;env.observe(map=>maps.push(map));assert.doesNotThrow(env.flush);
 env.flags.imageError=false;env.flags.srcError=true;env.resize(400,600);assert.doesNotThrow(env.flush);
 assert.equal(maps.at(-1),undefined);
 env.flags.srcError=false;env.resize(400,600);env.flush();env.images.at(-1)!.onload!(new Event('load'));
 assert.ok(maps.at(-1));
});

test('reduced transparency retires pending maps and re-enables with a fresh decode',t=>{
 const env=environment(t),maps:(refraction.RefractionFrame|undefined)[]=[];
 env.observe(map=>maps.push(map));env.flush();const late=env.images[0]!.onload!;
 env.transparency(true);env.flush();late(new Event('load'));
 assert.equal(maps.at(-1),undefined);
 env.transparency(false);env.flush();env.images.at(-1)!.onload!(new Event('load'));
 assert.ok(maps.at(-1));
});

test('WebKit and unsupported engines keep the blur fallback without texture work',t=>{
 const env=environment(t),maps:(refraction.RefractionFrame|undefined)[]=[];
 env.agent.userAgent='Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1';
 env.observe(map=>maps.push(map));env.flush();
 assert.equal(env.images.length,0);assert.equal(env.observers.length,0);assert.equal(maps.length,1);assert.equal(maps[0],undefined);
 env.agent.userAgent='Mozilla/5.0 Chrome/140.0.0.0';env.flags.supported=false;
 env.observe(map=>maps.push(map));env.flush();assert.equal(env.images.length,0);
});

test('large glass textures stay inside both resolution budgets',t=>{
 const {bitmaps}=environment(t);
 assert.ok((refraction.refractionMap as Function)(1100,1000,{radius:38,bezel:24,maxSide:320,maxPixels:65536}));
 const image=bitmaps[0]!;
 assert.ok(Math.max(image.width,image.height)<=320,'large sheets do not allocate a full-resolution texture');
 assert.ok(image.width*image.height<=65536,'rounding never exceeds the pixel budget');
});

test('surface corner geometry changes the map while the default stays rounded',t=>{
 const {bitmaps}=environment(t);
 refraction.refractionMap(80,80);
 (refraction.refractionMap as Function)(80,80,{radius:8,bezel:6});
 const channel=4*10+1;
 assert.equal(bitmaps[0]!.data[channel],128);
 assert.notEqual(bitmaps[1]!.data[channel],128,'a tight corner refracts the straight upper edge sooner');
});
