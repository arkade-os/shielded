export interface SwipeGestureOptions {allowButtons?:boolean;feedback?:HTMLElement;distance?:number}
export interface PullToRefreshState {distance:number;ready:boolean;refreshing:boolean}
export type SheetAction='close'|'next'|'previous';
interface GestureOptions {allowButtons?:boolean;distance:()=>number;onCommit:(delta:number)=>void}
interface GesturePointer {id:number;x:number;y:number;main:number;at:number;velocity:number;dragging:boolean}

function bindGesture(surface:HTMLElement,feedback:HTMLElement,options:GestureOptions):()=>void {
 const doc=surface.ownerDocument,variable='--wallet-swipe-drag',className='is-swipe-dragging';
 const original=feedback.style.getPropertyValue(variable);
 let pointer:GesturePointer|undefined,disposed=false,suppressUntil=0;
 const connected=()=>surface.isConnected&&feedback.isConnected;
 const main=(event:PointerEvent,current:GesturePointer)=>event.clientX-current.x;
 const restore=()=>{
  feedback.classList.remove(className);
  if(original)feedback.style.setProperty(variable,original);else feedback.style.removeProperty(variable);
 };
 const reset=()=>{
  const old=pointer;pointer=undefined;restore();
  if(old?.dragging)try{if(surface.hasPointerCapture(old.id))surface.releasePointerCapture(old.id);}catch{}
 };
 const down=(event:PointerEvent)=>{
  if(disposed||pointer||event.isPrimary===false||event.button!==0||!connected())return;
  suppressUntil=0;
  const target=event.target as Element|null;
  if(target?.closest?.('input,textarea,select,a,[contenteditable],[role="textbox"],[role="slider"],[data-gesture-ignore]'))return;
  if(!options.allowButtons&&target?.closest?.('button,[role="button"],[role="tab"]'))return;
  pointer={id:event.pointerId,x:event.clientX,y:event.clientY,main:0,at:event.timeStamp,velocity:0,dragging:false};
 };
 const move=(event:PointerEvent)=>{
  const current=pointer;if(!current||event.pointerId!==current.id)return;
  if(!connected()){reset();return;}
  const delta=main(event,current),cross=event.clientY-current.y;
  if(!current.dragging){
   if(Math.abs(cross)>=8&&Math.abs(cross)>Math.abs(delta)){reset();return;}
   if(Math.abs(delta)<8||Math.abs(delta)<Math.abs(cross)*1.15)return;
   current.dragging=true;feedback.classList.add(className);
   try{surface.setPointerCapture(event.pointerId);}catch{}
  }
  const elapsed=event.timeStamp-current.at;
  if(elapsed>0)current.velocity=(delta-current.main)/elapsed;
  current.main=delta;current.at=event.timeStamp;
  feedback.style.setProperty(variable,`${Math.max(-72,Math.min(72,delta*.35))}px`);
  if(event.cancelable)event.preventDefault();
 };
 const up=(event:PointerEvent)=>{
  const current=pointer;if(!current||event.pointerId!==current.id)return;
  const delta=main(event,current),elapsed=event.timeStamp-current.at;
  const velocity=elapsed>120?0:elapsed>0&&delta!==current.main?(delta-current.main)/elapsed:current.velocity;
  const distance=Math.max(24,options.distance());
  const commit=connected()&&current.dragging&&delta!==0&&(Math.abs(delta)>=distance||Math.abs(delta)>=24&&Math.sign(delta)*velocity>=.65);
  if(current.dragging)suppressUntil=event.timeStamp+400;
  reset();
  if(commit)options.onCommit(delta);
 };
 const cancel=(event?:Event)=>{
  if(event?.type==='lostpointercapture'&&event.target!==surface)return;
  if(event&&'pointerId' in event&&pointer?.id!==(event as PointerEvent).pointerId)return;
  if(pointer?.dragging&&event)suppressUntil=event.timeStamp+400;
  reset();
 };
 const hidden=()=>{if(doc.visibilityState==='hidden')cancel();};
 const click=(event:MouseEvent)=>{
  if(event.detail===0||!suppressUntil)return;
  const suppress=event.timeStamp<=suppressUntil;suppressUntil=0;
  if(suppress){event.preventDefault();event.stopImmediatePropagation();}
 };
 surface.addEventListener('pointerdown',down);
 surface.addEventListener('lostpointercapture',cancel);
 surface.addEventListener('click',click,true);
 doc.addEventListener('pointermove',move,{passive:false});
 doc.addEventListener('pointerup',up);
 doc.addEventListener('pointercancel',cancel);
 doc.addEventListener('visibilitychange',hidden);
 doc.defaultView?.addEventListener('blur',cancel);
 return ()=>{
  if(disposed)return;disposed=true;reset();suppressUntil=0;
  surface.removeEventListener('pointerdown',down);surface.removeEventListener('lostpointercapture',cancel);surface.removeEventListener('click',click,true);
  doc.removeEventListener('pointermove',move);doc.removeEventListener('pointerup',up);doc.removeEventListener('pointercancel',cancel);doc.removeEventListener('visibilitychange',hidden);doc.defaultView?.removeEventListener('blur',cancel);
 };
}

export function bindSwipeGesture(surface:HTMLElement,onSwipe:(direction:'previous'|'next')=>void,options:SwipeGestureOptions={}):()=>void {
 return bindGesture(surface,options.feedback??surface,{allowButtons:options.allowButtons,distance:()=>options.distance??56,onCommit:delta=>onSwipe(delta>0?'previous':'next')});
}

/** What a finished drag on an open sheet does: `ms` is how long it moved, so a short fast flick counts as well as a long drag. */
export function sheetGesture(dx:number,dy:number,ms:number,atTop:boolean):SheetAction|undefined {
 const x=Math.abs(dx),y=Math.abs(dy),fling=(distance:number)=>distance>=24&&distance>=Math.max(1,ms)*.5;
 if(y>x)return atTop&&dy>0&&(dy>=96||fling(dy))?'close':undefined;
 if(x>y&&(x>=64||fling(x)))return dx<0?'next':'previous';
 return undefined;
}

/** A sideways release pages only toward a sheet that is there; past the first or last one it springs back. */
export function sheetSnap(dx:number,ms:number,previous:boolean,next:boolean):'next'|'previous'|undefined {
 const action=sheetGesture(dx,0,ms,false);
 return action==='next'&&next||action==='previous'&&previous?action:undefined;
}
/** Rubber-banding: about half the finger's travel at first, never a whole sheet. */
export const sheetResistance=(overscroll:number,width:number)=>width*(1-1/(overscroll*.55/width+1));
export function sheetOffset(dx:number,width:number,previous:boolean,next:boolean):number {
 return dx>=0?(previous?Math.min(dx,width):sheetResistance(dx,width)):(next?Math.max(dx,-width):-sheetResistance(-dx,width));
}
export const sheetSnapMs=(distance:number,span:number)=>Math.round(160+120*Math.min(1,Math.abs(distance)/span));
const SNAP_EASING='cubic-bezier(.2,.7,.2,1)';

export function bindSheetGestures(sheet:HTMLElement,body:HTMLElement,onAction:(action:SheetAction)=>void,indicator?:HTMLElement|null):()=>void {
 const doc=sheet.ownerDocument;
 let pointer:{id:number;x:number;y:number;at:number;top:boolean;sideways:boolean;axis?:'x'|'y'}|undefined,disposed=false,suppressUntil=0;
 // A sideways drag moves every [data-sheet-page]: the sheet's title and body, and a peek at each neighbour the markup renders.
 let pages:HTMLElement[]=[],edges={previous:false,next:false},width=1,offset=0,glide:{animations:Animation[];land:()=>void}|undefined,drop:Animation|undefined;
 const sideScroller=(el:Element|null)=>{for(;el&&el!==body;el=el.parentElement)if(el.scrollWidth>el.clientWidth&&/auto|scroll/.test(doc.defaultView?.getComputedStyle(el).overflowX??''))return true;return false;};
 const place=(at:number)=>{
  offset=at;for(const page of pages)page.style.setProperty('transform',`translate3d(${at}px,0,0)`);
  indicator?.style.setProperty('--wallet-sheet-progress',String(Math.max(edges.previous?-1:0,Math.min(edges.next?1:0,-at/width))));
 };
 const rest=()=>{
  const old=glide;glide=undefined;for(const animation of old?.animations??[])animation.cancel();
  for(const page of pages.splice(0))page.style.removeProperty('transform');
  sheet.classList.remove('is-sheet-swiping');indicator?.classList.remove('is-swipe-dragging');indicator?.style.removeProperty('--wallet-sheet-progress');
 };
 const release=()=>{
  const old=pointer;pointer=undefined;
  sheet.classList.remove('is-sheet-dragging');sheet.style.removeProperty('--wallet-sheet-drag');
  if(old?.axis)try{if(sheet.hasPointerCapture(old.id))sheet.releasePointerCapture(old.id);}catch{}
 };
 const reset=()=>{release();rest();};
 // The sheet changes while the neighbour's peek still covers it, so the pages return to rest only onto the new content.
 const settle=(target:number,action?:'next'|'previous')=>{
  const moving=pages.length>0;
  const land=()=>{
   const top=sheet.getBoundingClientRect().top;
   try{if(action)onAction(action);}finally{rest();}
   // A sheet of another height (Activity floats above the dock) starts where the old one stood and glides to its own place.
   const shift=top-sheet.getBoundingClientRect().top;
   if(moving&&shift)drop=sheet.animate([{transform:`translate3d(0,${shift}px,0)`},{transform:'translate3d(0,0,0)'}],{duration:sheetSnapMs(shift,sheet.getBoundingClientRect().height||1),easing:SNAP_EASING});
  };
  if(!moving||offset===target){land();return;}
  const keyframes=[{transform:`translate3d(${offset}px,0,0)`},{transform:`translate3d(${target}px,0,0)`}],timing={duration:sheetSnapMs(target-offset,width),easing:SNAP_EASING,fill:'forwards' as const};
  const current={animations:pages.map(page=>page.animate(keyframes,timing)),land};glide=current;
  indicator?.classList.remove('is-swipe-dragging');indicator?.style.setProperty('--wallet-sheet-progress',String(-target/width));
  current.animations[0]!.finished.then(()=>{if(glide===current)land();},()=>{});
 };
 const down=(event:PointerEvent)=>{
  if(disposed||pointer||event.isPrimary===false||event.button!==0||!sheet.isConnected)return;
  glide?.land();drop?.cancel();
  suppressUntil=0;
  const target=event.target as Element|null,inBody=body.contains(target);
  // A mouse drag over the content selects text, so only the head moves the sheet for a mouse.
  if(target?.closest?.('input,textarea,select,[contenteditable],[role="textbox"],[role="slider"],[data-gesture-ignore]')||inBody&&event.pointerType==='mouse')return;
  pointer={id:event.pointerId,x:event.clientX,y:event.clientY,at:event.timeStamp,top:!inBody||body.scrollTop<=0,sideways:!target?.closest?.('[role="tablist"]')&&!sideScroller(target)};
 };
 const move=(event:PointerEvent)=>{
  const current=pointer;if(!current||event.pointerId!==current.id)return;
  if(!sheet.isConnected){reset();return;}
  const dx=event.clientX-current.x,dy=event.clientY-current.y;
  if(!current.axis){
   if(Math.abs(dx)<10&&Math.abs(dy)<10){current.at=event.timeStamp;return;}
   const axis=Math.abs(dx)>Math.abs(dy)?'x':'y';
   if(axis==='x'?!current.sideways:dy<0||!current.top){reset();return;}
   current.axis=axis;
   if(axis==='y')sheet.classList.add('is-sheet-dragging');
   else{
    const found=Array.from(sheet.querySelectorAll<HTMLElement>('[data-sheet-page]')),has=(side:string)=>found.some(page=>page.getAttribute('data-sheet-page')===side);
    edges={previous:has('previous'),next:has('next')};width=body.getBoundingClientRect().width||1;offset=0;
    // Reduced motion moves no page: the swipe still pages, at once, when it lands.
    if(!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches){pages=found;sheet.classList.add('is-sheet-swiping');indicator?.classList.add('is-swipe-dragging');}
   }
   try{sheet.setPointerCapture(event.pointerId);}catch{}
  }
  if(current.axis==='x'){if(pages.length)place(sheetOffset(dx,width,edges.previous,edges.next));}
  else{const limit=sheet.getBoundingClientRect().height*.6;sheet.style.setProperty('--wallet-sheet-drag',`${Math.max(0,dy<=limit?dy:limit+(dy-limit)*.25)}px`);}
  if(event.cancelable)event.preventDefault();
 };
 // As for the pull: Android pans a vertical touch natively and cancels the pointer unless the first cancelable move is claimed.
 const claim=(event:TouchEvent)=>{
  const current=pointer,touch=event.touches.length===1?event.touches[0]:undefined;
  if(!current||!touch||!event.cancelable)return;
  const dx=touch.clientX-current.x,dy=touch.clientY-current.y;
  if(current.axis||current.top&&dy>0&&!(Math.abs(dx)>=8&&Math.abs(dx)>=dy))event.preventDefault();
 };
 const up=(event:PointerEvent)=>{
  const current=pointer;if(!current||event.pointerId!==current.id)return;
  release();
  if(!current.axis)return;
  suppressUntil=event.timeStamp+400;
  if(!sheet.isConnected){rest();return;}
  const ms=event.timeStamp-current.at;
  if(current.axis==='x'){const action=sheetSnap(event.clientX-current.x,ms,edges.previous,edges.next);settle(action==='next'?-width:action==='previous'?width:0,action);return;}
  const action=sheetGesture(0,event.clientY-current.y,ms,current.top);
  if(action)onAction(action);
 };
 const cancel=(event?:Event)=>{
  const current=pointer;if(!current)return;
  if(event?.type==='lostpointercapture'&&event.target!==sheet)return;
  if(event&&'pointerId' in event&&current.id!==(event as PointerEvent).pointerId)return;
  if(current.axis&&event)suppressUntil=event.timeStamp+400;
  release();
  if(current.axis==='x')settle(0);
 };
 const hidden=()=>{if(doc.visibilityState==='hidden')cancel();};
 const click=(event:MouseEvent)=>{
  if(event.detail===0||!suppressUntil)return;
  const suppress=event.timeStamp<=suppressUntil;suppressUntil=0;
  if(suppress){event.preventDefault();event.stopImmediatePropagation();}
 };
 sheet.addEventListener('pointerdown',down);sheet.addEventListener('lostpointercapture',cancel);sheet.addEventListener('click',click,true);
 doc.addEventListener('pointermove',move,{passive:false});doc.addEventListener('touchmove',claim,{passive:false});doc.addEventListener('pointerup',up);doc.addEventListener('pointercancel',cancel);
 doc.addEventListener('visibilitychange',hidden);doc.defaultView?.addEventListener('blur',cancel);
 return()=>{
  if(disposed)return;disposed=true;reset();drop?.cancel();suppressUntil=0;
  sheet.removeEventListener('pointerdown',down);sheet.removeEventListener('lostpointercapture',cancel);sheet.removeEventListener('click',click,true);
  doc.removeEventListener('pointermove',move);doc.removeEventListener('touchmove',claim);doc.removeEventListener('pointerup',up);doc.removeEventListener('pointercancel',cancel);
  doc.removeEventListener('visibilitychange',hidden);doc.defaultView?.removeEventListener('blur',cancel);
 };
}

/** Android's back (the WebView goes back while it has history) closes the open sheet: one same-URL entry while it is open, dropped again when it closes any other way. A sheet over another passes its own `key`, so back closes only the top one. */
export function bindSheetBack(view:Pick<Window,'history'|'addEventListener'|'removeEventListener'>,close:()=>void,key='shieldedSheet'):()=>void {
 view.history.pushState({[key]:true},'');
 // A back() still queued from the previous close lands on that sheet's entry; only leaving every sheet entry closes this one.
 const back=(event:PopStateEvent)=>{if(!event.state?.[key])close();};
 view.addEventListener('popstate',back);
 return()=>{view.removeEventListener('popstate',back);if(view.history.state?.[key])view.history.back();};
}

/** A press held `ms` without moving past `slop` pixels. A scroll moves or cancels the pointer first, so it never fires. */
export function longPress(onHold:()=>void,ms=500,slop=10){
 let timer:ReturnType<typeof setTimeout>|undefined,start:{x:number;y:number}|undefined,held=false;
 const up=()=>{clearTimeout(timer);timer=undefined;start=undefined;};
 return {
  down(x:number,y:number){up();held=false;start={x,y};timer=setTimeout(()=>{up();held=true;onHold();},ms);},
  move(x:number,y:number){if(start&&Math.hypot(x-start.x,y-start.y)>slop)up();},
  up,
  /** True once, for the click that ends a hold: that press already did its work. */
  spent(){const was=held;held=false;return was;},
 };
}

export function bindPullToRefresh(surface:HTMLElement,refresh:()=>void|Promise<void>,options:{distance?:number;onState?:(state:PullToRefreshState)=>void;onError?:(error:unknown)=>void}={}):()=>void {
 const doc=surface.ownerDocument,threshold=options.distance??72;
 let pointer:{id:number;y:number;x:number;distance:number}|undefined,refreshing=false,disposed=false,suppressUntil=0;
 const flag=(name:string,on:boolean)=>{if(on)surface.classList.add(name);else surface.classList.remove(name);};
 const publish=(state:PullToRefreshState)=>{
  surface.style.setProperty('--wallet-pull-distance',`${state.distance}px`);
  flag('is-pulling-to-refresh',state.distance>0);
  flag('is-pull-ready',state.ready);
  flag('is-pull-refreshing',state.refreshing);
  options.onState?.(state);
 };
 const reset=(id?:number)=>{if(id!==undefined)try{if(surface.hasPointerCapture(id))surface.releasePointerCapture(id);}catch{}pointer=undefined;surface.style.removeProperty('--wallet-pull-distance');flag('is-pulling-to-refresh',false);flag('is-pull-ready',false);};
 const atTop=(target:Element|null)=>{
  const panel=target?.closest<HTMLElement>('.stock-panel');
  if(panel?.closest('.stock-page.has-dock'))return false;
  const page=doc.scrollingElement as HTMLElement|null|undefined;
  return (page?.scrollTop??doc.defaultView?.scrollY??0)<=0;
 };
 const down=(event:PointerEvent)=>{
  if(disposed||pointer||refreshing||event.isPrimary===false||event.button!==0)return;
  const target=event.target as Element|null;
  if(target?.closest?.('input,textarea,select,a,button,[role="button"],[role="tab"],[role="textbox"],[role="slider"],.stock-panel-head,.stock-backdrop,[data-pull-refresh-ignore]'))return;
  if(!atTop(target))return;
  suppressUntil=0;pointer={id:event.pointerId,y:event.clientY,x:event.clientX,distance:0};
 };
 const move=(event:PointerEvent)=>{
  const current=pointer;if(!current||event.pointerId!==current.id)return;
  const dy=event.clientY-current.y,dx=event.clientX-current.x;
  if(dy<=0||Math.abs(dx)>=8&&Math.abs(dx)>=Math.abs(dy)){reset(current.id);options.onState?.({distance:0,ready:false,refreshing:false});return;}
  if(current.distance===0&&Math.abs(dy)<8)return;
  if(!surface.isConnected){reset(current.id);return;}
  try{surface.setPointerCapture(event.pointerId);}catch{}
  current.distance=Math.min(96,Math.max(0,dy));
  publish({distance:current.distance,ready:current.distance>=threshold,refreshing:false});
  if(event.cancelable)event.preventDefault();
 };
 // Android hands a vertical touch drag to native panning and then fires pointercancel, so the pull claims the first cancelable move itself; preventDefault() in pointermove cannot.
 const panning=(event:TouchEvent)=>{
  const current=pointer,touch=event.touches.length===1?event.touches[0]:undefined;
  if(!current||!touch||!event.cancelable)return;
  const dy=touch.clientY-current.y,dx=touch.clientX-current.x;
  if(dy<=0||Math.abs(dx)>=8&&Math.abs(dx)>=dy)return;
  event.preventDefault();
 };
 const up=(event:PointerEvent)=>{
  const current=pointer;if(!current||event.pointerId!==current.id)return;
  const commit=current.distance>=threshold;
  if(commit)suppressUntil=event.timeStamp+400;
  reset(current.id);
  if(!commit){options.onState?.({distance:0,ready:false,refreshing:false});return;}
  refreshing=true;publish({distance:threshold,ready:false,refreshing:true});
  void Promise.resolve().then(refresh).catch(error=>options.onError?.(error)).finally(()=>{
   refreshing=false;
   if(disposed)return;
   surface.style.removeProperty('--wallet-pull-distance');flag('is-pulling-to-refresh',false);flag('is-pull-ready',false);flag('is-pull-refreshing',false);
   options.onState?.({distance:0,ready:false,refreshing:false});
  });
 };
 const cancel=(event?:Event)=>{
  if(event?.type==='lostpointercapture'&&event.target!==surface)return;
  if(event&&'pointerId' in event&&pointer?.id!==(event as PointerEvent).pointerId)return;
  if(pointer)reset(pointer.id);
  if(!refreshing)options.onState?.({distance:0,ready:false,refreshing:false});
 };
 const click=(event:MouseEvent)=>{
  if(event.detail===0||!suppressUntil)return;
  const suppress=event.timeStamp<=suppressUntil;suppressUntil=0;
  if(suppress){event.preventDefault();event.stopImmediatePropagation();}
 };
 const hidden=()=>{if(doc.visibilityState==='hidden')cancel();};
 surface.addEventListener('pointerdown',down);surface.addEventListener('lostpointercapture',cancel);surface.addEventListener('click',click,true);
 doc.addEventListener('pointermove',move,{passive:false});doc.addEventListener('touchmove',panning,{passive:false});doc.addEventListener('pointerup',up);doc.addEventListener('pointercancel',cancel);
 doc.addEventListener('visibilitychange',hidden);doc.defaultView?.addEventListener('blur',cancel);
 return()=>{
  if(disposed)return;disposed=true;refreshing=false;suppressUntil=0;if(pointer)reset(pointer.id);
  surface.style.removeProperty('--wallet-pull-distance');flag('is-pulling-to-refresh',false);flag('is-pull-ready',false);flag('is-pull-refreshing',false);
  options.onState?.({distance:0,ready:false,refreshing:false});
  surface.removeEventListener('pointerdown',down);surface.removeEventListener('lostpointercapture',cancel);surface.removeEventListener('click',click,true);
  doc.removeEventListener('pointermove',move);doc.removeEventListener('touchmove',panning);doc.removeEventListener('pointerup',up);doc.removeEventListener('pointercancel',cancel);
  doc.removeEventListener('visibilitychange',hidden);doc.defaultView?.removeEventListener('blur',cancel);
 };
}
