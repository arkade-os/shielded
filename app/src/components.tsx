import React from 'react';

export function Icon({name,size=20,className=''}:{name:string;size?:number;className?:string}) {
 const paths:Record<string,React.ReactNode> = {
 shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
 flow:<><circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h7a5 5 0 0 1 0 10H10a5 5 0 0 0 0 4h7"/></>,
 layers:<><path d="m12 3 10 5-10 5L2 8l10-5Z"/><path d="m2 12 10 5 10-5M2 16l10 5 10-5"/></>,
 code:<><path d="m8 5-6 7 6 7m8-14 6 7-6 7m-5-16-2 18"/></>,
 eye:<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></>,
 arrow:<><path d="M4 12h16m-6-6 6 6-6 6"/></>,
 chevron:<path d="m9 5 7 7-7 7"/>,
 check:<path d="m5 12 4 4L19 6"/>,
 bolt:<path d="m13 2-9 12h7l-1 8 10-12h-7l0-8Z"/>,
 lock:<><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14v3"/></>,
 plus:<path d="M12 4v16M4 12h16"/>,
 reset:<><path d="M3 9a9 9 0 1 1 0 6M3 3v6h6"/></>,
 clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
 external:<><path d="M14 3h7v7m0-7-11 11M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
 info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
 copy:<><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
 close:<path d="m6 6 12 12M18 6 6 18"/>,
 wallet:<><path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H5a3 3 0 0 1-3-3V6"/><path d="M20 11h-6v5h6M16 13.5h.01"/></>,
 test:<><path d="M9 3h6M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M8 14h8"/></>,
 download:<><path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6"/></>,
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]||paths.layers}</svg>
}
export function Hash({value,full=false}:{value?:string;full?:boolean}) { if(!value)return <span className="muted">Awaiting execution</span>;return <code title={value}>{full||value.length<22?value:`${value.slice(0,10)}…${value.slice(-8)}`}</code> }
export function Badge({children,tone='neutral'}:{children:React.ReactNode;tone?:string}) {return <span className={`badge ${tone}`}>{children}</span>}
export function Empty({icon='layers',title,description}:{icon?:string;title:string;description:string}){return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={23}/></div><strong>{title}</strong><p>{description}</p></div>}
export function CopyButton({value}:{value:string}) {const[copied,setCopied]=React.useState(false);return <button className="icon-button" aria-label="Copy to clipboard" onClick={async()=>{await navigator.clipboard.writeText(value);setCopied(true);setTimeout(()=>setCopied(false),1500)}}><Icon name={copied?'check':'copy'} size={16}/></button>}
