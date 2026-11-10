type Shutdown=()=>Promise<void>;
export type NativeWalletView<T>={session:T;retired:boolean;mounted:boolean;shutdown?:Shutdown;onShutdown:(shutdown:Shutdown|undefined)=>void};
type RetiredView<T>={session:T;shutdown?:Shutdown};
export const isNativeWalletViewActive=<T,>(view:NativeWalletView<T>,shown:boolean)=>shown&&!view.retired;
export const currentNativeWalletView=<T,>(view:NativeWalletView<T>|undefined)=>view&&!view.retired?view:undefined;

export function createNativeViewHandoff<T>(lateShutdown:(shutdown:Shutdown)=>void=shutdown=>{void shutdown().catch(()=>{});}){
 let shown:NativeWalletView<T>|undefined,candidate:NativeWalletView<T>|undefined;
 const retire=(view:NativeWalletView<T>):RetiredView<T>=>{
  view.retired=true;const shutdown=view.shutdown;view.shutdown=undefined;return {session:view.session,shutdown};
 };
 return {
  get snapshot(){return {shown,candidate};},
  stage(session:T,options:{awaitReady?:boolean}={}){
   const view:NativeWalletView<T>={session,retired:false,mounted:false,onShutdown(shutdown){
    if(view.retired){if(shutdown)lateShutdown(shutdown);return;}
    view.shutdown=shutdown;view.mounted=!!shutdown;
   }};
   if(candidate)throw new Error('The previous wallet candidate has not retired.');
   if(shown||options.awaitReady)candidate=view;else shown=view;
   return view;
  },
  promote(view:NativeWalletView<T>,current:()=>boolean){
   if(candidate!==view||view.retired||!view.mounted||!current())return false;
   shown=view;candidate=undefined;return true;
  },
  discard(view:NativeWalletView<T>){
   if(candidate!==view||view.retired)return;
   candidate=undefined;return retire(view);
  },
  retire(keepShown:boolean){
   const owned=[shown,candidate].filter((view):view is NativeWalletView<T>=>!!view&&!view.retired).map(retire);
   if(!keepShown||!shown?.mounted)shown=undefined;
   candidate=undefined;return owned;
  },
 };
}
