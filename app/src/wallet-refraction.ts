function signedDistance(x:number,y:number,width:number,height:number,radius:number){
 const dx=Math.abs(x-width/2)-(width/2-radius);
 const dy=Math.abs(y-height/2)-(height/2-radius);
 return Math.hypot(Math.max(dx,0),Math.max(dy,0))+Math.min(Math.max(dx,dy),0)-radius;
}

export function supportsBackdropRefraction(){
 // WebKit parses SVG backdrop URLs without rendering their displacement.
 return typeof CSS!=='undefined'&&CSS.supports('backdrop-filter','url(#wallet-liquid-glass)')&&/(?:Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent)&&!/(?:CriOS|EdgiOS|OPiOS)\//.test(navigator.userAgent);
}

export function refractionMap(width:number,height:number){
 const canvas=document.createElement('canvas');
 canvas.width=width;
 canvas.height=height;
 const context=canvas.getContext('2d');
 if(!context)return undefined;
 const image=context.createImageData(width,height);
 const radius=Math.min(24,width/2,height/2);
 const bezel=Math.min(18,height/3);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const offset=4*(y*width+x),distance=-signedDistance(x+.5,y+.5,width,height,radius);
  let red=128,green=128;
  if(distance>=0&&distance<bezel){
   const gradientX=signedDistance(x+1.5,y+.5,width,height,radius)-signedDistance(x-.5,y+.5,width,height,radius);
   const gradientY=signedDistance(x+.5,y+1.5,width,height,radius)-signedDistance(x+.5,y-.5,width,height,radius);
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
