import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {bindPullToRefresh,bindSheetBack,bindSheetGestures,bindSwipeGesture,longPress,sheetGesture,sheetOffset,sheetResistance,sheetSnap,sheetSnapMs} from '../app/src/wallet-gestures.ts';

class TestDocument extends EventTarget {visibilityState='visible';defaultView=Object.assign(new EventTarget(),{getComputedStyle:(el:TestElement)=>({overflowX:el.overflowX})});scrollingElement?:TestElement;}
class TestElement extends EventTarget {
 isConnected=true;
 values=new Map<string,string>();classes=new Set<string>();captured=new Set<number>();scrollTop=0;scrollWidth=0;clientWidth=0;overflowX='visible';top=0;
 children:TestElement[]=[];animations:{keyframes:Keyframe[];timing:KeyframeAnimationOptions;finish:()=>void;cancelled:boolean}[]=[];
 style={getPropertyValue:(name:string)=>this.values.get(name)??'',setProperty:(name:string,value:string)=>this.values.set(name,value),removeProperty:(name:string)=>{const old=this.values.get(name)??'';this.values.delete(name);return old;}};
 classList={add:(name:string)=>this.classes.add(name),remove:(...names:string[])=>names.forEach(name=>this.classes.delete(name)),contains:(name:string)=>this.classes.has(name)};
 constructor(readonly ownerDocument:TestDocument,readonly tag='div',readonly parent?:TestElement,readonly attributes:Record<string,string>={}){super();parent?.children.push(this);}
 get parentElement():TestElement|null{return this.parent??null;}
 contains(node:unknown):boolean{return node instanceof TestElement&&(node===this||this.contains(node.parent));}
 matches(selector:string):boolean{return selector.split(',').some(part=>{const s=part.trim(),classes=s.startsWith('.')?s.slice(1).split('.'):[],attribute=/^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);return s===this.tag||classes.length>0&&classes.every(name=>this.classes.has(name))||!!attribute&&attribute[1]! in this.attributes&&(attribute[2]===undefined||this.attributes[attribute[1]!]===attribute[2]);});}
 closest(selector:string):TestElement|null{return this.matches(selector)?this:this.parent?.closest(selector)??null;}
 querySelectorAll(selector:string):TestElement[]{return this.children.flatMap(child=>[...child.matches(selector)?[child]:[],...child.querySelectorAll(selector)]);}
 getAttribute(name:string){return this.attributes[name]??null;}
 animate(keyframes:Keyframe[],timing:KeyframeAnimationOptions){let finish=()=>{};const finished=new Promise<void>(resolve=>{finish=resolve;}),record={keyframes,timing,finish,cancelled:false};this.animations.push(record);return {finished,cancel:()=>{record.cancelled=true;}};}
 setPointerCapture(id:number){this.captured.add(id);}
 hasPointerCapture(id:number){return this.captured.has(id);}
 releasePointerCapture(id:number){this.captured.delete(id);}
 getBoundingClientRect(){return {height:600,width:360,top:this.top};}
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
function sheet(o:{previous?:boolean;next?:boolean;onAction?:()=>void}={previous:true,next:true}){
 const doc=new TestDocument(),surface=new TestElement(doc),head=new TestElement(doc,'div',surface),title=new TestElement(doc,'h2',head,{'data-sheet-page':''}),body=new TestElement(doc,'div',surface,{'data-sheet-page':''}),content=new TestElement(doc,'p',body),dock=new TestElement(doc,'nav'),actions:string[]=[];
 for(const side of ['previous','next'] as const)if(o[side])new TestElement(doc,'div',surface,{'data-sheet-page':side});
 const dispose=bindSheetGestures(element(surface),element(body),action=>{actions.push(action);o.onAction?.();},element(dock));
 return {doc,surface,head,title,body,content,dock,dispose,actions,pages:()=>surface.querySelectorAll('[data-sheet-page]'),dismissed:()=>actions.filter(action=>action==='close').length};
}
const land=async(s:ReturnType<typeof sheet>)=>{for(const page of s.pages())page.animations.at(-1)?.finish();await new Promise(resolve=>setImmediate(resolve));};

test('the sheet decision closes on a long or fast downward drag from the top and pages on a long or fast sideways one',()=>{
 for(const [dx,dy,ms,top,expected] of [
  [0,96,800,true,'close'],[4,40,40,true,'close'],[0,95,800,true,undefined],[0,200,100,false,undefined],[0,-200,100,true,undefined],[0,23,1,true,undefined],
  [-64,0,800,false,'next'],[64,5,800,true,'previous'],[-30,2,40,true,'next'],[-63,0,800,true,undefined],[40,40,10,true,undefined],
 ] as const)assert.equal(sheetGesture(dx,dy,ms,top),expected,`${dx},${dy} in ${ms}ms, top ${top}`);
});

test('a sideways release pages toward a sheet that is there and springs back past the first or last',()=>{
 for(const [dx,ms,previous,next,expected] of [
  [-64,800,true,true,'next'],[64,800,true,true,'previous'],[-30,40,false,true,'next'],[-63,800,true,true,undefined],
  [-200,800,true,false,undefined],[200,800,false,true,undefined],[200,100,true,false,'previous'],
 ] as const)assert.equal(sheetSnap(dx,ms,previous,next),expected,`${dx}px in ${ms}ms`);
});

test('the pages keep up with the finger toward a neighbour, resist where there is none, and snap faster the less is left',()=>{
 assert.equal(sheetOffset(-150,360,true,true),-150);assert.equal(sheetOffset(500,360,true,true),360,'never past the neighbour');assert.equal(sheetOffset(0,360,false,false),0);
 assert.equal(sheetOffset(100,360,false,true).toFixed(1),'47.7');assert.equal(sheetOffset(-100,360,true,false),-sheetOffset(100,360,false,true));
 const pulls=[50,100,200,400,10_000],held=pulls.map(dx=>sheetResistance(dx,360));
 assert.ok(held.every((pull,i)=>pull<pulls[i]!*.55&&(i===0||pull>held[i-1]!))&&held.at(-1)!<360,`${held}`);
 assert.deepEqual([sheetSnapMs(0,360),sheetSnapMs(-180,360),sheetSnapMs(360,360),sheetSnapMs(900,360)],[160,220,280,280]);
});

test('a sheet follows a downward drag, snaps back below threshold and dismisses only once beyond it',()=>{
 const s=sheet();
 pointer(s.surface,'pointerdown',0,0,0,{target:s.content});pointer(s.doc,'pointermove',1,60,200);
 assert.equal(s.surface.values.get('--wallet-sheet-drag'),'60px');assert.ok(s.surface.classes.has('is-sheet-dragging'));
 pointer(s.doc,'pointerup',1,60,500);assert.equal(s.dismissed(),0);assert.equal(s.surface.values.get('--wallet-sheet-drag'),undefined);
 pointer(s.surface,'pointerdown',0,0,600,{target:s.content});pointer(s.doc,'pointermove',2,140,900);pointer(s.doc,'pointerup',2,140,1000);pointer(s.doc,'pointerup',2,180,1010);
 assert.equal(s.dismissed(),1);assert.equal(s.surface.classes.has('is-sheet-dragging'),false);assert.equal(s.surface.captured.size,0);s.dispose();
});

test('a short deliberate flick dismisses, but holding the same displacement or dragging up does not',()=>{
 const fast=sheet();pointer(fast.surface,'pointerdown',0,0,0,{target:fast.content});pointer(fast.doc,'pointermove',1,30,10);pointer(fast.doc,'pointerup',1,30,12);assert.equal(fast.dismissed(),1);fast.dispose();
 const slow=sheet();pointer(slow.surface,'pointerdown',0,0,0,{target:slow.content});pointer(slow.doc,'pointermove',1,30,10);pointer(slow.doc,'pointerup',1,30,400);assert.equal(slow.dismissed(),0);
 pointer(slow.surface,'pointerdown',0,100,500,{target:slow.content});pointer(slow.doc,'pointermove',1,0,520);pointer(slow.doc,'pointerup',1,0,530);assert.equal(slow.dismissed(),0);slow.dispose();
 const held=sheet();pointer(held.surface,'pointerdown',0,0,0,{target:held.content});pointer(held.doc,'pointermove',0,3,500);pointer(held.doc,'pointermove',0,40,520);pointer(held.doc,'pointerup',0,40,530);
 assert.equal(held.dismissed(),1,'a pause before the flick does not slow it down');held.dispose();
});

test('a downward drag in scrolled content stays native scrolling, while the head still closes',()=>{
 const s=sheet();s.body.scrollTop=40;
 pointer(s.surface,'pointerdown',0,0,0,{target:s.content});const moved=pointer(s.doc,'pointermove',0,120,100);pointer(s.doc,'pointerup',0,120,120);
 assert.equal(moved.defaultPrevented,false);assert.equal(s.surface.captured.size,0);assert.deepEqual(s.actions,[]);
 pointer(s.surface,'pointerdown',0,0,200,{target:s.head});pointer(s.doc,'pointermove',0,120,300);pointer(s.doc,'pointerup',0,120,320);
 assert.deepEqual(s.actions,['close']);s.dispose();
});

test('a sideways drag carries every page with the finger and snaps to the neighbour, but not from fields, tab strips or sideways scrollers',async()=>{
 const held:(string|undefined)[]=[],s=sheet({previous:true,next:true,onAction:()=>held.push(s.body.values.get('transform'))});
 pointer(s.surface,'pointerdown',200,0,0,{target:s.content});pointer(s.doc,'pointermove',100,4,100);
 assert.deepEqual(s.pages().map(page=>page.values.get('transform')),Array(4).fill('translate3d(-100px,0,0)'),'title, body and both peeks');
 assert.ok(s.surface.classes.has('is-sheet-swiping'));
 pointer(s.doc,'pointerup',100,4,120);
 assert.deepEqual(s.actions,[],'the sheet changes only once the snap lands');
 assert.deepEqual(s.body.animations[0]?.keyframes,[{transform:'translate3d(-100px,0,0)'},{transform:'translate3d(-360px,0,0)'}]);
 assert.equal(s.body.animations[0]?.timing.duration,sheetSnapMs(260,360));
 await land(s);
 assert.deepEqual(s.actions,['next']);assert.deepEqual(held,['translate3d(-100px,0,0)'],'the new sheet renders before the pages come back');
 assert.equal(s.body.values.size,0);assert.ok(s.body.animations[0]!.cancelled);
 pointer(s.surface,'pointerdown',0,0,200,{target:s.head});pointer(s.doc,'pointermove',30,0,210);pointer(s.doc,'pointerup',30,0,220);await land(s);
 assert.deepEqual(s.actions,['next','previous']);assert.equal(s.surface.values.size,0);assert.equal(s.surface.classes.size,0);
 const strip=new TestElement(s.doc,'div',s.body,{role:'tablist'}),tab=new TestElement(s.doc,'button',strip),scroller=new TestElement(s.doc,'div',s.body),inner=new TestElement(s.doc,'span',scroller);
 Object.assign(scroller,{scrollWidth:600,clientWidth:300,overflowX:'auto'});
 for(const target of [...['input','textarea','select'].map(tag=>new TestElement(s.doc,tag,s.body)),tab,inner]){pointer(s.surface,'pointerdown',200,0,300,{target});pointer(s.doc,'pointermove',0,0,400);pointer(s.doc,'pointerup',0,0,420);}
 assert.deepEqual(s.actions,['next','previous']);
 pointer(s.surface,'pointerdown',0,0,500,{target:tab});pointer(s.doc,'pointermove',0,120,600);pointer(s.doc,'pointerup',0,120,620);
 assert.deepEqual(s.actions,['next','previous','close'],'a tab strip still lets the sheet close');s.dispose();
});

test('the first movement decides the axis for the rest of the drag',async()=>{
 const s=sheet();
 pointer(s.surface,'pointerdown',100,100,0,{target:s.content});pointer(s.doc,'pointermove',100,80,20);pointer(s.doc,'pointermove',0,80,60);pointer(s.doc,'pointerup',0,80,80);
 assert.deepEqual(s.actions,[]);
 pointer(s.surface,'pointerdown',100,0,100,{target:s.content});pointer(s.doc,'pointermove',80,2,110);pointer(s.doc,'pointermove',30,150,160);
 assert.equal(s.surface.values.get('--wallet-sheet-drag'),undefined);assert.equal(s.body.values.get('transform'),'translate3d(-70px,0,0)');
 pointer(s.doc,'pointerup',30,150,170);await land(s);
 assert.deepEqual(s.actions,['next']);s.dispose();
});

test('at the first or last sheet a sideways drag resists, keeps the dock highlight in place and springs back without paging',async()=>{
 const s=sheet({next:true});
 pointer(s.surface,'pointerdown',100,0,0,{target:s.content});pointer(s.doc,'pointermove',300,0,300);
 assert.equal(s.body.values.get('transform'),`translate3d(${sheetResistance(200,360)}px,0,0)`);assert.equal(s.dock.values.get('--wallet-sheet-progress'),'0');
 pointer(s.doc,'pointerup',300,0,320);
 assert.deepEqual(s.body.animations[0]?.keyframes.at(-1),{transform:'translate3d(0px,0,0)'});
 await land(s);assert.deepEqual(s.actions,[]);assert.equal(s.body.values.size,0);s.dispose();
});

test('with reduced motion a swipe pages at once and nothing slides',()=>{
 const s=sheet();Object.assign(s.doc.defaultView,{matchMedia:(query:string)=>({matches:query==='(prefers-reduced-motion: reduce)'})});
 pointer(s.surface,'pointerdown',200,0,0,{target:s.content});pointer(s.doc,'pointermove',100,0,100);
 assert.equal(s.body.values.size,0);assert.equal(s.surface.classes.has('is-sheet-swiping'),false);assert.equal(s.dock.values.size,0);
 pointer(s.doc,'pointerup',100,0,120);
 assert.deepEqual(s.actions,['next']);assert.equal(s.body.animations.length,0);assert.equal(s.surface.animations.length,0);s.dispose();
});

test('a touch during the snap lands it first, and a sheet closed mid-snap does not page',async()=>{
 const s=sheet();
 pointer(s.surface,'pointerdown',200,0,0,{target:s.content});pointer(s.doc,'pointermove',100,0,100);pointer(s.doc,'pointerup',100,0,120);
 pointer(s.surface,'pointerdown',150,0,130,{target:s.content});
 assert.deepEqual(s.actions,['next']);assert.equal(s.body.values.size,0);assert.ok(s.body.animations[0]!.cancelled);
 pointer(s.doc,'pointerup',150,0,140);
 pointer(s.surface,'pointerdown',200,0,200,{target:s.content});pointer(s.doc,'pointermove',100,0,300);pointer(s.doc,'pointerup',100,0,320);
 s.dispose();await land(s);
 assert.deepEqual(s.actions,['next']);assert.equal(s.body.values.size,0);assert.equal(s.surface.classes.size,0);
});

test('the dock highlight follows the drag, then eases over with the snap',async()=>{
 const s=sheet();
 pointer(s.surface,'pointerdown',200,0,0,{target:s.content});pointer(s.doc,'pointermove',110,0,100);
 assert.equal(s.dock.values.get('--wallet-sheet-progress'),'0.25');assert.ok(s.dock.classes.has('is-swipe-dragging'));
 pointer(s.doc,'pointerup',110,0,120);
 assert.equal(s.dock.values.get('--wallet-sheet-progress'),'1');assert.equal(s.dock.classes.has('is-swipe-dragging'),false);
 await land(s);assert.equal(s.dock.values.size,0);s.dispose();
});

test('a sheet of another height starts where the old one stood and glides to its own place',async()=>{
 const s=sheet({previous:true,next:true,onAction:()=>{s.surface.top=175;}});s.surface.top=23;
 pointer(s.surface,'pointerdown',200,0,0,{target:s.content});pointer(s.doc,'pointermove',100,0,100);pointer(s.doc,'pointerup',100,0,120);await land(s);
 assert.deepEqual(s.surface.animations.map(animation=>animation.keyframes),[[{transform:'translate3d(0,-152px,0)'},{transform:'translate3d(0,0,0)'}]]);
 pointer(s.surface,'pointerdown',200,0,200,{target:s.content});pointer(s.doc,'pointermove',100,0,300);pointer(s.doc,'pointerup',100,0,320);await land(s);
 assert.equal(s.surface.animations.length,1,'the same height does not move');s.dispose();
});

test('each open sheet names itself in its head, the dialog takes that heading as its name, and a swipe lands on a rendered sheet',()=>{
 const wallet=readFileSync(new URL('../app/src/RollupWallet.tsx',import.meta.url),'utf8');
 assert.match(wallet,/'aria-labelledby':'stock-panel-title'/);assert.doesNotMatch(wallet,/'aria-label':tab===/);
 assert.match(wallet,/<div className="stock-panel-head"><h2 id="stock-panel-title" data-sheet-page="">\{titled\(tab\)\}<\/h2>/);
 assert.match(wallet,/className="stock-panel-body" data-sheet-page=""/);assert.match(wallet,/data-sheet-page=\{side\} aria-hidden="true"><h2>\{titled\(name\)\}<\/h2>/);
 assert.match(wallet,/flushSync\(\(\)=>view\.openPanel\(next\)\)/);
 assert.match(readFileSync(new URL('../app/src/wallet-glass.css',import.meta.url),'utf8'),/\.stock-panel\.is-send,\.stock-page\.has-dock \.stock-panel\.is-receive\{height:/,'Send and Receive share one frame, so paging between them never resizes the sheet');
});

test('a closing drag claims the native pan on Android, leaving upward, scrolled and pinch moves to the browser',()=>{
 const s=sheet();
 assert.equal(touchmove(s.doc,0,20).defaultPrevented,false);
 pointer(s.surface,'pointerdown',0,0,0,{target:s.content});
 assert.equal(touchmove(s.doc,0,4).defaultPrevented,true);
 assert.equal(touchmove(s.doc,0,-6).defaultPrevented,false);
 assert.equal(touchmove(s.doc,40,4).defaultPrevented,false);
 assert.equal(touchmove(s.doc,0,20,true,2).defaultPrevented,false);
 pointer(s.doc,'pointerup',0,0,100);
 s.body.scrollTop=50;pointer(s.surface,'pointerdown',0,0,200,{target:s.content});
 assert.equal(touchmove(s.doc,0,20).defaultPrevented,false);pointer(s.doc,'pointerup',0,0,300);
 pointer(s.surface,'pointerdown',100,0,400,{target:s.content});pointer(s.doc,'pointermove',60,2,410);
 assert.equal(touchmove(s.doc,40,30).defaultPrevented,true,'a locked swipe keeps the vertical pan from taking over');
 s.dispose();pointer(s.surface,'pointerdown',0,0,500,{target:s.content});assert.equal(touchmove(s.doc,0,20).defaultPrevented,false);
});

test('a drag that starts on a button moves the sheet and eats that pointer click, but a tap or keyboard activation still clicks',()=>{
 const s=sheet(),button=new TestElement(s.doc,'button',s.body);let clicks=0;s.surface.addEventListener('click',()=>clicks++);
 pointer(s.surface,'pointerdown',0,0,0,{target:button});pointer(s.doc,'pointermove',0,130,50);pointer(s.doc,'pointerup',0,130,60);
 assert.deepEqual(s.actions,['close']);assert.equal(click(s.surface,61).defaultPrevented,true);assert.equal(clicks,0);
 assert.equal(click(s.surface,62,0).defaultPrevented,false);assert.equal(clicks,1);
 pointer(s.surface,'pointerdown',0,0,100,{target:button});pointer(s.doc,'pointerup',0,0,110);assert.equal(click(s.surface,111).defaultPrevented,false);assert.equal(clicks,2);s.dispose();
});

test('an open sheet holds one history entry that back closes, and a sheet closed another way gives it back',()=>{
 const stack:unknown[]=[null],events=new EventTarget();let index=0,closed=0;
 const view={history:{get state(){return stack[index];},pushState:(state:unknown)=>{stack.splice(index+1,Infinity,state);index++;},back:()=>{if(index>0){index--;events.dispatchEvent(new Event('popstate'));}}},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)} as unknown as Parameters<typeof bindSheetBack>[0];
 const dispose=bindSheetBack(view,()=>closed++);assert.equal(index,1);
 view.history.back();assert.equal(closed,1);dispose();assert.equal(index,0,'back is not taken twice');
 bindSheetBack(view,()=>closed++)();assert.equal(index,0);assert.equal(closed,1);
});

test('the dock offers Activity, Receive and Send, and no sheet open is home',()=>{
 const wallet=readFileSync(new URL('../app/src/RollupWallet.tsx',import.meta.url),'utf8'),dock=/<nav ref=\{dockNode\}[^\n]*<\/nav>/.exec(wallet)?.[0]??'';
 assert.match(wallet,/const DOCK=\['activity','receive','send'\] as const;/);
 assert.match(dock,/'--glass-count':DOCK\.length/);assert.match(dock,/\{DOCK\.map\(/);assert.match(dock,/\(sheetOpen\?'':' is-home'\)/);
 assert.doesNotMatch(dock,/'home'/);
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
 const s=sheet(),at={target:s.content};
 pointer(s.surface,'pointerdown',0,0,0,{...at,button:2});pointer(s.doc,'pointermove',0,200,10);pointer(s.doc,'pointerup',0,200,20);assert.equal(s.dismissed(),0);
 pointer(s.surface,'pointerdown',0,0,30,{...at,isPrimary:false});pointer(s.doc,'pointermove',0,200,40);pointer(s.doc,'pointerup',0,200,50);assert.equal(s.dismissed(),0);
 pointer(s.surface,'pointerdown',0,0,60,at);pointer(s.surface,'pointerdown',0,0,70,{...at,pointerId:2});pointer(s.doc,'pointermove',0,200,80,{pointerId:2});pointer(s.doc,'pointerup',0,200,90,{pointerId:2});assert.equal(s.dismissed(),0);
 pointer(s.doc,'pointermove',0,120,200);pointer(s.doc,'pointerup',0,120,220);assert.equal(s.dismissed(),1);s.dispose();
});

test('cancel, lost capture, hidden document and blur reset without dismissing',()=>{
 for(const cancel of ['pointercancel','lostpointercapture','visibilitychange','blur']){
  const s=sheet();pointer(s.surface,'pointerdown',0,0,0,{target:s.content});pointer(s.doc,'pointermove',0,120,100);
  if(cancel==='visibilitychange'){s.doc.visibilityState='hidden';s.doc.dispatchEvent(new Event(cancel));}
  else if(cancel==='blur')s.doc.defaultView.dispatchEvent(new Event(cancel));
  else pointer(cancel==='lostpointercapture'?s.surface:s.doc,cancel,0,120,110);
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
 const s=sheet(),at={target:s.content};pointer(s.surface,'pointerdown',0,0,0,at);pointer(s.doc,'pointermove',0,140,100);s.surface.isConnected=false;pointer(s.doc,'pointerup',0,140,110);assert.equal(s.dismissed(),0);
 s.surface.isConnected=true;pointer(s.surface,'pointerdown',0,0,200,at);pointer(s.doc,'pointermove',0,140,300);s.dispose();s.dispose();pointer(s.doc,'pointerup',0,140,310);
 pointer(s.surface,'pointerdown',0,0,400,at);pointer(s.doc,'pointermove',0,150,410);pointer(s.doc,'pointerup',0,150,420);assert.equal(s.dismissed(),0);assert.equal(s.surface.values.size,0);assert.equal(s.surface.classes.size,0);assert.equal(s.surface.captured.size,0);
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

test('mouse, touch and pen contacts use the same primary-pointer dismissal path from the head, and a mouse over content stays text selection',()=>{
 for(const pointerType of ['mouse','touch','pen']){
  const s=sheet();pointer(s.surface,'pointerdown',0,0,0,{target:s.head,pointerType});pointer(s.doc,'pointermove',0,120,100,{pointerType});pointer(s.doc,'pointerup',0,120,120,{pointerType});
  assert.equal(s.dismissed(),1,pointerType);s.dispose();
 }
 const s=sheet();pointer(s.surface,'pointerdown',0,0,0,{target:s.content,pointerType:'mouse'});pointer(s.doc,'pointermove',0,120,100,{pointerType:'mouse'});pointer(s.doc,'pointerup',0,120,120,{pointerType:'mouse'});
 assert.equal(s.dismissed(),0);assert.equal(s.surface.captured.size,0);s.dispose();
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

test('pull to refresh ignores controls, horizontal movement, scrolled content and an open docked sheet',async()=>{
 const doc=new TestDocument(),surface=new TestElement(doc),button=new TestElement(doc,'button',surface);let refreshes=0;
 const dispose=bindPullToRefresh(element(surface),()=>{refreshes++;});
 pointer(surface,'pointerdown',0,0,0,{target:button});pointer(doc,'pointermove',0,100,100);pointer(doc,'pointerup',0,100,120);
 pointer(surface,'pointerdown',0,0,200);pointer(doc,'pointermove',80,4,300);pointer(doc,'pointerup',80,4,320);
 pointer(surface,'pointerdown',0,0,400);pointer(doc,'pointermove',0,100,500);pointer(doc,'pointerup',0,100,520);
 const dockedPage=new TestElement(doc,'div',surface);dockedPage.classList.add('stock-page');dockedPage.classList.add('has-dock');
 const panel=new TestElement(doc,'div',dockedPage);panel.classList.add('stock-panel');panel.scrollTop=100;const content=new TestElement(doc,'p',panel);
 pointer(surface,'pointerdown',0,0,600,{target:content});pointer(doc,'pointermove',0,100,700);pointer(doc,'pointerup',0,100,720);
 panel.scrollTop=0;pointer(surface,'pointerdown',0,0,800,{target:content});pointer(doc,'pointermove',0,100,900);pointer(doc,'pointerup',0,100,920);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(refreshes,1,'the open sheet closes on that drag instead');dispose();
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

test('a back still queued from the last close does not close the sheet that reopened',async()=>{
 const stack:unknown[]=[null],events=new EventTarget(),tick=()=>new Promise(resolve=>setTimeout(resolve));let index=0,closed=0;
 const view={history:{get state(){return stack[index];},pushState:(state:unknown)=>{stack.splice(index+1,Infinity,state);index++;},back:()=>{setTimeout(()=>{if(index>0){index--;events.dispatchEvent(Object.assign(new Event('popstate'),{state:stack[index]}));}});}},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)} as unknown as Parameters<typeof bindSheetBack>[0];
 bindSheetBack(view,()=>closed++)();
 const dispose=bindSheetBack(view,()=>closed++);await tick();
 assert.equal(closed,0);
 view.history.back();await tick();assert.equal(closed,1);dispose();
});

test('a sheet opened over another takes back first and leaves the one beneath open',()=>{
 const stack:unknown[]=[null],events=new EventTarget();let index=0,under=0,over=0;
 const view={history:{get state(){return stack[index];},pushState:(state:unknown)=>{stack.splice(index+1,Infinity,state);index++;},back:()=>{if(index>0){index--;events.dispatchEvent(Object.assign(new Event('popstate'),{state:stack[index]}));}}},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)} as unknown as Parameters<typeof bindSheetBack>[0];
 const below=bindSheetBack(view,()=>under++),above=bindSheetBack(view,()=>over++,'shieldedTx');
 view.history.back();assert.deepEqual([over,under],[1,0]);above();assert.equal(index,1,'the closed top sheet takes no second back');
 view.history.back();assert.equal(under,1);below();assert.equal(index,0);
});

test('a long press fires once after the hold and spends only the click that ends it',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let holds=0;const press=longPress(()=>holds++);
 press.down(0,0);t.mock.timers.tick(499);assert.equal(holds,0);
 press.move(3,4);t.mock.timers.tick(1);assert.equal(holds,1,'a wobble inside the slop still holds');
 press.up();assert.equal(press.spent(),true);assert.equal(press.spent(),false);
 press.down(0,0);press.up();assert.equal(press.spent(),false,'a tap still clicks');
});

test('movement or an early release stops a long press, and a new press forgets an unspent hold',t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let holds=0;const press=longPress(()=>holds++);
 press.down(0,0);press.move(0,11);t.mock.timers.tick(600);
 press.down(0,0);t.mock.timers.tick(300);press.up();t.mock.timers.tick(600);
 assert.equal(holds,0);assert.equal(press.spent(),false);
 press.down(0,0);t.mock.timers.tick(500);assert.equal(holds,1);
 press.down(5,5);press.up();assert.equal(press.spent(),false,'Android sends no click after a hold, so the next tap must still open');
});
