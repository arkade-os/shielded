export function createPasskeyRevealOwner(){
 let active:AbortController|undefined;
 const cancel=()=>{active?.abort();active=undefined;};
 return {
  cancel,get active(){return !!active;},
  begin(){
   cancel();const controller=new AbortController();active=controller;
   return {signal:controller.signal,current(){if(active!==controller||controller.signal.aborted)throw new Error('The recovery request was closed.');},finish(){if(active===controller)active=undefined;}};
  },
 };
}
