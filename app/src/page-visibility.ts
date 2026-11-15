export function watchPageVisibility(
 listener:(visible:boolean)=>void,
 doc:EventTarget&{readonly hidden:boolean}=document,
 win:EventTarget=window
){
 let frozen=false,away=false,visible:boolean|undefined;
 const notify=()=>{
  const next=!doc.hidden&&!frozen&&!away;
  if(next!==visible){visible=next;listener(next);}
 };
 const freeze=()=>{frozen=true;notify();},resume=()=>{frozen=false;notify();};
 const hide=()=>{away=true;notify();},show=()=>{away=false;notify();};
 doc.addEventListener('visibilitychange',notify);
 doc.addEventListener('freeze',freeze);doc.addEventListener('resume',resume);
 win.addEventListener('pagehide',hide);win.addEventListener('pageshow',show);
 notify();
 return()=>{
  doc.removeEventListener('visibilitychange',notify);
  doc.removeEventListener('freeze',freeze);doc.removeEventListener('resume',resume);
  win.removeEventListener('pagehide',hide);win.removeEventListener('pageshow',show);
 };
}
