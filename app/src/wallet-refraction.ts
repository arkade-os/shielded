function signedDistance(x:number,y:number,width:number,height:number,radius:number){
 const dx=Math.abs(x-width/2)-(width/2-radius);
 const dy=Math.abs(y-height/2)-(height/2-radius);
 return Math.hypot(Math.max(dx,0),Math.max(dy,0))+Math.min(Math.max(dx,dy),0)-radius;
}

export function supportsBackdropRefraction(){
 // WebKit parses SVG backdrop URLs without rendering their displacement.
 return typeof CSS!=='undefined'&&CSS.supports('backdrop-filter','url(#wallet-liquid-glass)')&&/(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent)&&!/(?:CriOS|EdgiOS|OPiOS)\//.test(navigator.userAgent);
}

export interface RefractionOptions {radius?:number;bezel?:number;maxSide?:number;maxPixels?:number}
export interface RefractionFrame {width:number;height:number;href:string}

export function refractionMap(width:number,height:number,options:RefractionOptions={}){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<2||height<2)return undefined;
 const scale=Math.min(1,(options.maxSide??Infinity)/Math.max(width,height),Math.sqrt((options.maxPixels??Infinity)/(width*height)));
 if(!Number.isFinite(scale)||scale<=0)return undefined;
 const textureWidth=Math.max(1,Math.floor(width*scale)),textureHeight=Math.max(1,Math.floor(height*scale));
 const canvas=document.createElement('canvas');
 canvas.width=textureWidth;
 canvas.height=textureHeight;
 const context=canvas.getContext('2d');
 if(!context)return undefined;
 const image=context.createImageData(textureWidth,textureHeight);
 const radius=Math.min(options.radius??24,width/2,height/2);
 const bezel=Math.min(options.bezel??18,height/3);
 for(let y=0;y<textureHeight;y++)for(let x=0;x<textureWidth;x++){
  const px=(x+.5)*width/textureWidth,py=(y+.5)*height/textureHeight;
  const offset=4*(y*textureWidth+x),distance=-signedDistance(px,py,width,height,radius);
  let red=128,green=128;
  if(distance>=0&&distance<bezel){
   const gradientX=signedDistance(px+1,py,width,height,radius)-signedDistance(px-1,py,width,height,radius);
   const gradientY=signedDistance(px,py+1,width,height,radius)-signedDistance(px,py-1,width,height,radius);
   const length=Math.hypot(gradientX,gradientY)||1;
   const u=distance/bezel,strength=1-u*u*(3-2*u);
   red=Math.round(127.5-127.5*gradientX/length*strength);
   green=Math.round(127.5-127.5*gradientY/length*strength);
  }
  image.data[offset]=red;
  image.data[offset+1]=green;
  image.data[offset+2]=128;
  image.data[offset+3]=255;
 }
 context.putImageData(image,0,0);
 return canvas.toDataURL('image/png');
}

export function observeRefraction(node:HTMLElement,publish:(map:RefractionFrame|undefined)=>void,options:RefractionOptions={}){
 publish(undefined);
 if(!supportsBackdropRefraction())return ()=>{};
 const preference=typeof matchMedia==='function'?matchMedia('(prefers-reduced-transparency: reduce)'):undefined;
 let live=true,frame=0,lastWidth=0,lastHeight=0,revision=0,pending:HTMLImageElement|undefined;
 const clearImage=()=>{if(pending)pending.onload=pending.onerror=null;pending=undefined;};
 const reset=()=>{revision++;clearImage();lastWidth=lastHeight=0;publish(undefined);};
 const measure=()=>{
  if(!live)return;
  if(pending){revision++;clearImage();lastWidth=lastHeight=0;publish(undefined);}
  cancelAnimationFrame(frame);
  frame=requestAnimationFrame(()=>{
   frame=0;
   if(!live)return;
   const rect=node.getBoundingClientRect(),width=Math.round(rect.width),height=Math.round(rect.height);
   if(preference?.matches||width<2||height<2){reset();return;}
   if(width===lastWidth&&height===lastHeight)return;
   lastWidth=width;lastHeight=height;
   const current=++revision;
   clearImage();publish(undefined);
   let href:string|undefined;
   try{href=refractionMap(width,height,{maxSide:320,maxPixels:65536,...options});}catch{href=undefined;}
   if(!href){lastWidth=lastHeight=0;return;}
   try{
    const image=new Image();pending=image;
    image.onload=()=>{if(live&&current===revision&&!preference?.matches){pending=undefined;publish({width,height,href});}};
    image.onerror=()=>{if(live&&current===revision){clearImage();lastWidth=lastHeight=0;publish(undefined);}};
    image.src=href;
   }catch{clearImage();lastWidth=lastHeight=0;publish(undefined);}
  });
 };
 const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(measure);
 observer?.observe(node);window.addEventListener('resize',measure);preference?.addEventListener?.('change',measure);measure();
 return()=>{live=false;revision++;clearImage();observer?.disconnect();window.removeEventListener('resize',measure);preference?.removeEventListener?.('change',measure);cancelAnimationFrame(frame);};
}
