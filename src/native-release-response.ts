import {parseNativeRelease,type NativeRelease} from './native-release.ts';

export const NATIVE_RELEASE_MAX_BYTES=64*1024;

export async function readNativeReleaseResponse(response:Response):Promise<NativeRelease>{
 const reject=async(message:string):Promise<never>=>{await response.body?.cancel().catch(()=>{});throw new Error(message);};
 if(!response.ok)return reject('Native release metadata unavailable');
 const declared=response.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>NATIVE_RELEASE_MAX_BYTES))return reject('Native release metadata too large');
 if(!response.body)throw new Error('Native release metadata is empty');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
 let size=0,text='';
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   size+=value.byteLength;if(size>NATIVE_RELEASE_MAX_BYTES)throw new Error('Native release metadata too large');
   text+=decoder.decode(value,{stream:true});
  }
  return parseNativeRelease(JSON.parse(text+decoder.decode()));
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{reader.releaseLock();}
}
