import assert from 'node:assert/strict';
import test from 'node:test';
import {bindPullToRefresh,bindSheetGesture,bindSwipeGesture} from '../app/src/wallet-gestures.ts';

class TestDocument extends EventTarget {visibilityState='visible';defaultView=new EventTarget();scrollingElement?:TestElement;}
class TestElement extends EventTarget {
 isConnected=true;
 values=new Map<string,string>();classes=new Set<string>();captured=new Set<number>();scrollTop=0;
 style={getPropertyValue:(name:string)=>this.values.get(name)??'',setProperty:(name:string,value:string)=>this.values.set(name,value),removeProperty:(name:string)=>{const old=this.values.get(name)??'';this.values.delete(name);return old;}};
 classList={add:(name:string)=>this.classes.add(name),remove:(name:string)=>this.classes.delete(name),contains:(name:string)=>this.classes.has(name)};
 constructor(readonly ownerDocument:TestDocument,readonly tag='div',readonly parent?:TestElement,readonly attributes:Record<string,string>={}){super();}
 closest(selector:string):TestElement|null{return selector.split(',').some(part=>{const s=part.trim(),classes=s.startsWith('.')?s.slice(1).split('.'):[];return s===this.tag||classes.length>0&&classes.every(name=>this.classes.has(name))||s==='[contenteditable]'&&'contenteditable' in this.attributes||s==='[data-gesture-ignore]'&&'data-gesture-ignore' in this.attributes||s===`[role="${this.attributes.role}"]`;})?this:this.parent?.closest(selector)??null;}
 setPointerCapture(id:number){this.captured.add(id);}
 hasPointerCapture(id:number){return this.captured.has(id);}
 releasePointerCapture(id:number){this.captured.delete(id);}
 getBoundingClientRect(){return {height:600,width:360};}
}
const element=(node:TestElement)=>node as unknown as HTMLElement;
function pointer(target:EventTarget,type:string,x:number,y:number,time:number,extra:Record<string,unknown>={}){
 const event=new Event(type,{cancelable:true});
 Object.defineProperties(event,Object.fromEntries(Object.entries({pointerId:1,isPrimary:true,button:0,clientX:x,clientY:y,timeStamp:time,...extra}).map(([key,value])=>[key,{value}])));
 target.dispatchEvent(event);return event;
}
function click(target:EventTarget,time:number,detail=1){const event=new Event('click',{cancelable:true});Object.defineProperties(event,{timeStamp:{value:time},detail:{value:detail}});target.dispatchEvent(event);return event;}
function touchmove(target:EventTarget,x:number,y:number,cancelable=true,contacts=1){
 const event=new Event('touchmove',{cancelable});
 Object.defineProperty(event,'touches',{value:Array.from({length:contacts},()=>({clientX:x,clientY:y}))});
 target.dispatchEvent(event);return event;
}
function sheet(){const doc=new TestDocument(),handle=new TestElement(doc),surface=new TestElement(doc);let dismissed=0;const dispose=bindSheetGesture(element(handle),element(surface),()=>dismissed++,{distance:100});return {doc,handle,surface,dispose,dismissed:()=>dismissed};}

test('a sheet follows a downward drag, snaps back below threshold and dismisses only once beyond it',()=>{
 const s=sheet();
 pointer(s.handle,'pointerdown',0,0,0);pointer(s.doc,'pointermove',1,60,200);
 assert.equal(s.surface.values.get('--wallet-sheet-drag'),'60px');assert.ok(s.surface.classes.has('is-sheet-dragging'));
 pointer(s.doc,'pointerup',1,60,500);assert.equal(s.dismissed(),0);assert.equal(s.surface.values.get('--wallet-sheet-drag'),undefined);
 pointer(s.handle,'pointerdown',0,0,600);pointer(s.doc,'pointermove',2,140,900);pointer(s.doc,'pointerup',2,140,1000);pointer(s.doc,'pointerup',2,180,1010);
 assert.equal(s.dismissed(),1);assert.equal(s.surface.classes.has('is-sheet-dragging'),false);assert.equal(s.handle.captured.size,0);s.dispose();
});

test('a short deliberate flick dismisses, but holding the same displacement or dragging up does not',()=>{
 const fast=sheet();pointer(fast.handle,'pointerdown',0,0,0);pointer(fast.doc,'pointermove',1,30,10);pointer(fast.doc,'pointerup',1,30,12);assert.equal(fast.dismissed(),1);fast.dispose();
 const slow=sheet();pointer(slow.handle,'pointerdown',0,0,0);pointer(slow.doc,'pointermove',1,30,10);pointer(slow.doc,'pointerup',1,30,400);assert.equal(slow.dismissed(),0);
 pointer(slow.handle,'pointerdown',0,100,500);pointer(slow.doc,'pointermove',1,0,520);pointer(slow.doc,'pointerup',1,0,530);assert.equal(slow.dismissed(),0);slow.dispose();
});

test('vertical scrolling wins over horizontal swipes without capture or prevented defaults',()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),directions:string[]=[],dispose=bindSwipeGesture(element(surface),direction=>directions.push(direction));
 pointer(surface,'pointerdown',100,100,0);const moved=pointer(doc,'pointermove',104,145,20);pointer(doc,'pointermove',0,145,40);pointer(doc,'pointerup',0,145,60);
 assert.equal(moved.defaultPrevented,false);assert.equal(surface.captured.size,0);assert.deepEqual(directions,[]);dispose();
});

test('horizontal drags navigate in both directions and suppress their pointer click, preserving keyboard activation',()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),directions:string[]=[],dispose=bindSwipeGesture(element(surface),direction=>directions.push(direction));let clicks=0;surface.addEventListener('click',()=>clicks++);
 pointer(surface,'pointerdown',100,100,0);pointer(doc,'pointermove',20,102,100);pointer(doc,'pointerup',20,102,120);
 assert.deepEqual(directions,['next']);assert.equal(click(surface,121).defaultPrevented,true);assert.equal(clicks,0);
 assert.equal(click(surface,122,0).defaultPrevented,false);assert.equal(clicks,1);
 pointer(surface,'pointerdown',0,0,200);pointer(doc,'pointermove',80,2,300);pointer(doc,'pointerup',80,2,320);assert.deepEqual(directions,['next','previous']);dispose();
});

test('broad swipes ignore controls and editable content while a navigation strip permits button taps and drags',()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),directions:string[]=[],dispose=bindSwipeGesture(element(surface),direction=>directions.push(direction));
 for(const [tag,attributes] of [['button',{}],['a',{}],['input',{}],['textarea',{}],['select',{}],['div',{contenteditable:''}],['div',{'data-gesture-ignore':''}]] as [string,Record<string,string>][]){
  const control=new TestElement(doc,tag,surface,attributes);pointer(surface,'pointerdown',100,0,0,{target:control});pointer(doc,'pointermove',0,0,100);pointer(doc,'pointerup',0,0,120);
 }
 assert.deepEqual(directions,[]);dispose();
 const navDirections:string[]=[],strip=new TestElement(doc),button=new TestElement(doc,'button',strip),off=bindSwipeGesture(element(strip),direction=>navDirections.push(direction),{allowButtons:true});let taps=0;strip.addEventListener('click',()=>taps++);
 pointer(strip,'pointerdown',100,0,200,{target:button});pointer(doc,'pointerup',100,0,220);click(strip,221);assert.equal(taps,1);
 pointer(strip,'pointerdown',100,0,300,{target:button});pointer(doc,'pointermove',10,0,400);pointer(doc,'pointerup',10,0,420);click(strip,421);assert.equal(taps,1);assert.deepEqual(navDirections,['next']);off();
});

test('secondary buttons, non-primary contacts and other pointer IDs cannot take over a drag',()=>{
 const s=sheet();
 pointer(s.handle,'pointerdown',0,0,0,{button:2});pointer(s.doc,'pointermove',0,200,10);pointer(s.doc,'pointerup',0,200,20);assert.equal(s.dismissed(),0);
 pointer(s.handle,'pointerdown',0,0,30,{isPrimary:false});pointer(s.doc,'pointermove',0,200,40);pointer(s.doc,'pointerup',0,200,50);assert.equal(s.dismissed(),0);
 pointer(s.handle,'pointerdown',0,0,60);pointer(s.handle,'pointerdown',0,0,70,{pointerId:2});pointer(s.doc,'pointermove',0,200,80,{pointerId:2});pointer(s.doc,'pointerup',0,200,90,{pointerId:2});assert.equal(s.dismissed(),0);
 pointer(s.doc,'pointermove',0,120,200);pointer(s.doc,'pointerup',0,120,220);assert.equal(s.dismissed(),1);s.dispose();
});

test('cancel, lost capture, hidden document and blur reset without dismissing',()=>{
 for(const cancel of ['pointercancel','lostpointercapture','visibilitychange','blur']){
  const s=sheet();pointer(s.handle,'pointerdown',0,0,0);pointer(s.doc,'pointermove',0,120,100);
  if(cancel==='visibilitychange'){s.doc.visibilityState='hidden';s.doc.dispatchEvent(new Event(cancel));}
  else if(cancel==='blur')s.doc.defaultView.dispatchEvent(new Event(cancel));
  else pointer(cancel==='lostpointercapture'?s.handle:s.doc,cancel,0,120,110);
  pointer(s.doc,'pointerup',0,160,120);assert.equal(s.dismissed(),0,cancel);assert.equal(s.surface.classes.size,0,cancel);assert.equal(s.surface.values.size,0,cancel);s.dispose();
 }
});

test('a touch swipe survives implicit capture moving from its child button to the navigation strip',()=>{
 const doc=new TestDocument(),strip=new TestElement(doc),button=new TestElement(doc,'button',strip),directions:string[]=[];
 const dispose=bindSwipeGesture(element(strip),direction=>directions.push(direction),{allowButtons:true});
 pointer(strip,'pointerdown',100,0,0,{target:button,pointerType:'touch'});button.setPointerCapture(1);
 pointer(doc,'pointermove',20,1,100,{pointerType:'touch'});button.releasePointerCapture(1);
 pointer(strip,'lostpointercapture',20,1,101,{target:button,pointerType:'touch'});
 assert.ok(strip.classes.has('is-swipe-dragging'));assert.equal(strip.hasPointerCapture(1),true);
 pointer(doc,'pointerup',20,1,120,{pointerType:'touch'});
 assert.deepEqual(directions,['next']);assert.equal(strip.classes.size,0);assert.equal(strip.captured.size,0);dispose();
});

test('only loss of the active pointer capture on the owning surface cancels its swipe',()=>{
 const doc=new TestDocument(),strip=new TestElement(doc),directions:string[]=[],dispose=bindSwipeGesture(element(strip),direction=>directions.push(direction));
 pointer(strip,'pointerdown',100,0,0);pointer(doc,'pointermove',20,0,100);
 pointer(strip,'lostpointercapture',20,0,101,{pointerId:2});assert.ok(strip.classes.has('is-swipe-dragging'));
 pointer(strip,'lostpointercapture',20,0,102);assert.equal(strip.classes.size,0);assert.equal(strip.values.size,0);
 pointer(doc,'pointerup',20,0,120);assert.deepEqual(directions,[]);dispose();
});

test('detachment and idempotent disposal retire a pending drag without callbacks or residual feedback',()=>{
 const s=sheet();pointer(s.handle,'pointerdown',0,0,0);pointer(s.doc,'pointermove',0,140,100);s.surface.isConnected=false;pointer(s.doc,'pointerup',0,140,110);assert.equal(s.dismissed(),0);
 s.surface.isConnected=true;pointer(s.handle,'pointerdown',0,0,200);pointer(s.doc,'pointermove',0,140,300);s.dispose();s.dispose();pointer(s.doc,'pointerup',0,140,310);
 pointer(s.handle,'pointerdown',0,0,400);pointer(s.doc,'pointermove',0,150,410);pointer(s.doc,'pointerup',0,150,420);assert.equal(s.dismissed(),0);assert.equal(s.surface.values.size,0);assert.equal(s.surface.classes.size,0);assert.equal(s.handle.captured.size,0);
});

test('a new pointer press clears suppression so a later deliberate click is not eaten',()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),dispose=bindSwipeGesture(element(surface),()=>{});let clicks=0;surface.addEventListener('click',()=>clicks++);
 pointer(surface,'pointerdown',100,0,0);pointer(doc,'pointermove',0,0,100);pointer(doc,'pointerup',0,0,120);
 pointer(surface,'pointerdown',20,0,130);pointer(doc,'pointerup',20,0,140);assert.equal(click(surface,141).defaultPrevented,false);assert.equal(clicks,1);dispose();
});

test('an icon inside an interactive control cannot start a broad swipe',()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),button=new TestElement(doc,'button',surface),icon=new TestElement(doc,'svg',button);let changed=0;
 const dispose=bindSwipeGesture(element(surface),()=>changed++);
 pointer(surface,'pointerdown',100,0,0,{target:icon});pointer(doc,'pointermove',0,0,100);pointer(doc,'pointerup',0,0,120);
 assert.equal(changed,0);assert.equal(surface.classes.size,0);dispose();
});

test('mouse, touch and pen contacts use the same primary-pointer dismissal path',()=>{
 for(const pointerType of ['mouse','touch','pen']){
  const s=sheet();pointer(s.handle,'pointerdown',0,0,0,{pointerType});pointer(s.doc,'pointermove',0,120,100,{pointerType});pointer(s.doc,'pointerup',0,120,120,{pointerType});
  assert.equal(s.dismissed(),1,pointerType);s.dispose();
 }
});

test('pulling down from the top refreshes once and publishes its progress',async()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),states:boolean[]=[];let refreshes=0;
 const dispose=bindPullToRefresh(element(surface),async()=>{refreshes++;},{distance:60,onState:state=>states.push(state.refreshing)});
 pointer(surface,'pointerdown',0,0,0);pointer(doc,'pointermove',0,70,100);assert.ok(surface.classes.has('is-pulling-to-refresh'));
 pointer(doc,'pointermove',0,5,110);assert.equal(surface.values.get('--wallet-pull-distance'),'5px');assert.equal(surface.classes.has('is-pull-ready'),false);
 pointer(doc,'pointermove',0,70,115);pointer(doc,'pointerup',0,70,120);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refreshes,1);assert.equal(states.at(-1),false);assert.equal(surface.classes.size,0);dispose();
});

test('pull to refresh ignores controls, horizontal movement and scrolled content',async()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),button=new TestElement(doc,'button',surface);let refreshes=0;
 const dispose=bindPullToRefresh(element(surface),()=>{refreshes++;});
 pointer(surface,'pointerdown',0,0,0,{target:button});pointer(doc,'pointermove',0,100,100);pointer(doc,'pointerup',0,100,120);
 pointer(surface,'pointerdown',0,0,200);pointer(doc,'pointermove',80,4,300);pointer(doc,'pointerup',80,4,320);
 pointer(surface,'pointerdown',0,0,400);pointer(doc,'pointermove',0,100,500);pointer(doc,'pointerup',0,100,520);
 const dockedPage=new TestElement(doc,'div',surface);dockedPage.classList.add('stock-page');dockedPage.classList.add('has-dock');
 const panel=new TestElement(doc,'div',dockedPage);panel.classList.add('stock-panel');panel.scrollTop=100;const content=new TestElement(doc,'p',panel);
 pointer(surface,'pointerdown',0,0,600,{target:content});pointer(doc,'pointermove',0,100,700);pointer(doc,'pointerup',0,100,720);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refreshes,1);dispose();
});

test('an undocked panel uses the document scroll position before accepting a pull',async()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),page=new TestElement(doc),panel=new TestElement(doc,'div',surface),content=new TestElement(doc,'p',panel);let refreshes=0;
 panel.classList.add('stock-panel');page.scrollTop=100;doc.scrollingElement=page;
 const dispose=bindPullToRefresh(element(surface),()=>{refreshes++;});
 pointer(surface,'pointerdown',0,0,0,{target:content});pointer(doc,'pointermove',0,100,100);pointer(doc,'pointerup',0,100,120);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshes,0);dispose();
});

test('disposing a pending pull clears its state and an old completion cannot replace a new binding',async()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),states:boolean[]=[];
 let finishOld=()=>{},finishNew=()=>{};
 const first=bindPullToRefresh(element(surface),()=>new Promise<void>(resolve=>{finishOld=resolve;}),{distance:60,onState:state=>states.push(state.refreshing)});
 pointer(surface,'pointerdown',0,0,0);pointer(doc,'pointermove',0,70,100);pointer(doc,'pointerup',0,70,120);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(states.at(-1),true);first();assert.equal(states.at(-1),false);
 const second=bindPullToRefresh(element(surface),()=>new Promise<void>(resolve=>{finishNew=resolve;}),{distance:60,onState:state=>states.push(state.refreshing)});
 pointer(surface,'pointerdown',0,0,200);pointer(doc,'pointermove',0,70,300);pointer(doc,'pointerup',0,70,320);
 assert.equal(states.at(-1),true);finishOld();await new Promise(resolve=>setImmediate(resolve));assert.equal(states.at(-1),true);
 finishNew();await new Promise(resolve=>setImmediate(resolve));assert.equal(states.at(-1),false);second();
});

test('a downward pull claims the native pan, leaving scrolling, pinching and scrolled content to the browser',()=>{
 const doc=new TestDocument(),surface=new TestElement(doc);
 const dispose=bindPullToRefresh(element(surface),()=>{},{distance:60});
 assert.equal(touchmove(doc,0,20).defaultPrevented,false);
 pointer(surface,'pointerdown',0,0,0);
 assert.equal(touchmove(doc,0,4).defaultPrevented,true);
 assert.equal(touchmove(doc,0,20).defaultPrevented,true);
 assert.equal(touchmove(doc,0,20,false).defaultPrevented,false);
 assert.equal(touchmove(doc,0,20,true,2).defaultPrevented,false);
 assert.equal(touchmove(doc,0,-20).defaultPrevented,false);
 assert.equal(touchmove(doc,40,4).defaultPrevented,false);
 pointer(doc,'pointerup',0,0,200);
 const page=new TestElement(doc,'div',surface);page.classList.add('stock-page');page.classList.add('has-dock');
 const panel=new TestElement(doc,'div',page);panel.classList.add('stock-panel');panel.scrollTop=100;const content=new TestElement(doc,'p',panel);
 pointer(surface,'pointerdown',0,0,300,{target:content});
 assert.equal(touchmove(doc,0,20).defaultPrevented,false);
 dispose();
 pointer(surface,'pointerdown',0,0,400);assert.equal(touchmove(doc,0,20).defaultPrevented,false);
});

test('a pull refresh failure reaches the explicit error channel and releases its state',async()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),errors:unknown[]=[];
 const dispose=bindPullToRefresh(element(surface),async()=>{throw new Error('refresh failed');},{distance:60,onError:error=>errors.push(error)});
 pointer(surface,'pointerdown',0,0,0);pointer(doc,'pointermove',0,70,100);pointer(doc,'pointerup',0,70,120);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal((errors[0] as Error).message,'refresh failed');assert.equal(surface.classes.size,0);dispose();
});
