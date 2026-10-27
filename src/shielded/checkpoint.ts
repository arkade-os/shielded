import type {PoolApi} from './pool.ts';

/** The batch a restore starts at for a wallet made on or after `createdAt`, a day early; picked from every checkpoint's time so the pool never learns the date. */
export async function birthCheckpoint(api:PoolApi,createdAt:number):Promise<number>{
 const {every,at}=await api<{every:number;at:number[]}>('/times');
 let k=0;at.forEach((time,i)=>{if(time<=createdAt-86_400_000)k=i;});
 return k*every;
}
