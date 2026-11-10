export interface SwipeGestureOptions {allowButtons?:boolean;feedback?:HTMLElement;distance?:number}
export interface PullToRefreshState {distance:number;ready:boolean;refreshing:boolean}
interface GestureOptions {axis:'x'|'y';allowButtons?:boolean;distance:()=>number;onCommit:(delta:number)=>void}
interface GesturePointer {id:number;x:number;y:number;main:number;at:number;velocity:number;dragging:boolean}

function bindGesture(surface:HTMLElement,feedback:HTMLElement,options:GestureOptions):()=>void {
 const doc=surface.ownerDocument,vertical=options.axis==='y',variable=vertical?'--wallet-sheet-drag':'--wallet-swipe-drag',className=vertical?'is-sheet-dragging':'is-swipe-dragging';
 const original=feedback.style.getPropertyValue(variable),originalProgress=feedback.style.getPropertyValue('--wallet-sheet-progress');
 let pointer:GesturePointer|undefined,disposed=false,suppressUntil=0;
 const connected=()=>surface.isConnected&&feedback.isConnected;
 const main=(event:PointerEvent,current:GesturePointer)=>vertical?event.clientY-current.y:event.clientX-current.x;
 const restore=()=>{
  feedback.classList.remove(className);
  if(original)feedback.style.setProperty(variable,original);else feedback.style.removeProperty(variable);
  if(vertical){if(originalProgress)feedback.style.setProperty('--wallet-sheet-progress',originalProgress);else feedback.style.removeProperty('--wallet-sheet-progress');}
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
  const delta=main(event,current),cross=vertical?event.clientX-current.x:event.clientY-current.y;
  if(!current.dragging){
   if(Math.abs(cross)>=8&&Math.abs(cross)>Math.abs(delta)||vertical&&delta<=-8){reset();return;}
   if(Math.abs(delta)<8||Math.abs(delta)<Math.abs(cross)*1.15)return;
   current.dragging=true;feedback.classList.add(className);
   try{surface.setPointerCapture(event.pointerId);}catch{}
  }
  const elapsed=event.timeStamp-current.at;
  if(elapsed>0)current.velocity=(delta-current.main)/elapsed;
  current.main=delta;current.at=event.timeStamp;
  const height=Math.max(1,feedback.getBoundingClientRect().height),limit=height*.6;
  const offset=vertical?Math.max(0,delta<=limit?delta:limit+(delta-limit)*.25):Math.max(-72,Math.min(72,delta*.35));
  feedback.style.setProperty(variable,`${offset}px`);
  if(vertical)feedback.style.setProperty('--wallet-sheet-progress',String(Math.max(0,Math.min(1,delta/height))));
  if(event.cancelable)event.preventDefault();
 };
 const up=(event:PointerEvent)=>{
  const current=pointer;if(!current||event.pointerId!==current.id)return;
  const delta=main(event,current),elapsed=event.timeStamp-current.at;
  const velocity=elapsed>120?0:elapsed>0&&delta!==current.main?(delta-current.main)/elapsed:current.velocity;
  const direction=vertical?delta>0:delta!==0;
  const distance=Math.max(24,options.distance());
  const commit=connected()&&current.dragging&&direction&&(Math.abs(delta)>=distance||Math.abs(delta)>=24&&Math.sign(delta)*velocity>=.65);
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

export function bindSheetGesture(handle:HTMLElement,sheet:HTMLElement,onDismiss:()=>void,options:{distance?:number}={}):()=>void {
 return bindGesture(handle,sheet,{axis:'y',distance:()=>options.distance??Math.min(128,Math.max(72,sheet.getBoundingClientRect().height*.22)),onCommit:onDismiss});
}
export function bindSwipeGesture(surface:HTMLElement,onSwipe:(direction:'previous'|'next')=>void,options:SwipeGestureOptions={}):()=>void {
 return bindGesture(surface,options.feedback??surface,{axis:'x',allowButtons:options.allowButtons,distance:()=>options.distance??56,onCommit:delta=>onSwipe(delta>0?'previous':'next')});
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
  if(panel?.closest('.stock-page.has-dock'))return panel.scrollTop<=0;
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
 doc.addEventListener('pointermove',move,{passive:false});doc.addEventListener('pointerup',up);doc.addEventListener('pointercancel',cancel);
 doc.addEventListener('visibilitychange',hidden);doc.defaultView?.addEventListener('blur',cancel);
 return()=>{
  if(disposed)return;disposed=true;refreshing=false;suppressUntil=0;if(pointer)reset(pointer.id);
  surface.style.removeProperty('--wallet-pull-distance');flag('is-pulling-to-refresh',false);flag('is-pull-ready',false);flag('is-pull-refreshing',false);
  options.onState?.({distance:0,ready:false,refreshing:false});
  surface.removeEventListener('pointerdown',down);surface.removeEventListener('lostpointercapture',cancel);surface.removeEventListener('click',click,true);
  doc.removeEventListener('pointermove',move);doc.removeEventListener('pointerup',up);doc.removeEventListener('pointercancel',cancel);
  doc.removeEventListener('visibilitychange',hidden);doc.defaultView?.removeEventListener('blur',cancel);
 };
}
