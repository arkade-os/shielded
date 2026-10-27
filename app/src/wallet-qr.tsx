import {useEffect,useMemo,useRef,useState} from 'react';
import encodeQR from 'qr';

export function QrCode({value,label}:{value:string;label:string}){
 const {size,d}=useMemo(()=>{const rows=encodeQR(value,'raw',{border:2});return {size:rows.length,d:rows.flatMap((row,y)=>row.map((dark,x)=>dark?`M${x} ${y}h1v1h-1z`:'')).join('')};},[value]);
 return <svg className="stock-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges"><rect width={size} height={size} fill="#fff"/><path d={d} fill="#0b2338"/></svg>;
}

const cameraProblem=(error:unknown)=>{
 const name=(error as {name?:string}|undefined)?.name;
 return name==='NotAllowedError'?'This site may not use the camera. Allow it in the browser settings, or paste the code instead.'
  :name==='NotFoundError'||name==='OverconstrainedError'?'No camera was found. Paste the code instead.'
  :'The camera did not start. Paste the code instead.';
};

/** A modal <dialog>: the browser makes the page behind it inert and keeps focus inside. */
export function Scanner({onResult,onClose}:{onResult:(text:string)=>void;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),video=useRef<HTMLVideoElement>(null),done=useRef(onResult),[problem,setProblem]=useState('');
 done.current=onResult;
 useEffect(()=>{
  dialog.current?.showModal();
  let live=true,stop=()=>{};
  // The decoder loads only when someone scans.
  void import('qr/dom.js').then(async({QRCanvas,frameLoop,rearCamera})=>{
   const camera=await rearCamera(video.current!);
   if(!live)return camera.stop();
   const canvas=new QRCanvas();let reading=false;
   const cancel=frameLoop(()=>{
    if(reading)return;reading=true;
    void camera.readFrame(canvas).then(found=>{reading=false;if(live&&typeof found==='string'){live=false;stop();done.current(found);}},()=>{reading=false;});
   });
   stop=()=>{cancel();camera.stop();};
  }).catch((error:unknown)=>{if(live)setProblem(cameraProblem(error));});
  return()=>{live=false;stop();};
 },[]);
 // Escape must close only the scanner, not the sheet listening on window behind it.
 return <dialog ref={dialog} className="stock-scan" aria-label="Scan a payment code" onCancel={e=>{e.preventDefault();onClose();}} onKeyDown={e=>{if(e.key==='Escape')e.stopPropagation();}}>
  <video ref={video} playsInline muted/>
  <span className="stock-scan-frame" aria-hidden="true"/>
  <p role="status">{problem||'Point the camera at a payment QR code.'}</p>
  <button type="button" onClick={onClose} autoFocus>Close</button>
 </dialog>;
}
