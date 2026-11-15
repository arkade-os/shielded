export function createPasskeyRevealOwner(){
 let active:AbortController|undefined;
 const cancel=()=>{active?.abort();active=undefined;};
 return {
  cancel,get active(){return !!active;},
  begin(){
   cancel();const controller=new AbortController();active=controller;
   const current=()=>{if(active!==controller||controller.signal.aborted)throw new Error('The recovery request was closed.');};
   return {signal:controller.signal,current,publish(foreground:()=>boolean,show:()=>void){current();if(!foreground())throw new Error('Return to the foreground and try showing the recovery phrase again.');show();},finish(){if(active===controller)active=undefined;}};
  },
 };
}
