export interface SwipeGestureOptions {allowButtons?:boolean;feedback?:HTMLElement;distance?:number}
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
