import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CARRIER_FREE_SATS,acceptsDepositFee,carrierFeeOf,depositFeeOf,maxDepositFeeOf,parseDepositFee,parseDepositFeeSchedule} from '../packages/protocol/src/rollup/deposit-fee.ts';
import {rollupAddressOf} from '../packages/protocol/src/rollup/wallet.ts';

const address=rollupAddressOf({owner:1n,viewPublic:new Uint8Array(32).fill(7)});

test('the deposit fee is the larger of its fixed floor and its rounded-up bps share',()=>{
 assert.equal(depositFeeOf({fixedSats:100,bps:50},10_000n),100n);
 assert.equal(depositFeeOf({fixedSats:100,bps:50},100_000n),500n);
 assert.equal(depositFeeOf({fixedSats:0,bps:1},1n),1n);
 assert.equal(depositFeeOf({fixedSats:0,bps:1},10n**20n+1n),10n**16n+1n);
 assert.equal(depositFeeOf({fixedSats:0,bps:0},1_000n),0n);
 assert.equal(depositFeeOf(undefined,1_000n),0n);
});

test('a carrier pays nothing up to the free allowance and the whole fee above it',()=>{
 assert.equal(carrierFeeOf({fixedSats:100,bps:0},BigInt(CARRIER_FREE_SATS)),0n);
 assert.equal(carrierFeeOf({fixedSats:100,bps:0},BigInt(CARRIER_FREE_SATS)+1n),100n);
 assert.equal(carrierFeeOf({fixedSats:0,bps:100},BigInt(CARRIER_FREE_SATS)+1n),4n,'the bps share is taken on the whole carrier, not on what is above the allowance');
 assert.equal(carrierFeeOf(undefined,1_000n),0n);
});

test('a fee schedule is read only when both numbers are whole, non-negative and no more than the whole deposit',()=>{
 const fee={fixedSats:100,bps:25,address};
 assert.deepEqual(parseDepositFee({...fee,viewKey:'never advertised'}),fee);
 assert.ok(parseDepositFee({...fee,fixedSats:0,bps:10_000}));
 assert.ok(parseDepositFee({...fee,bps:0}),'a flat fee is a fee');
 for(const bad of [{bps:10_001},{bps:-1},{bps:1.5},{bps:'25'},{fixedSats:-1},{fixedSats:2**53},{fixedSats:0,bps:0},{address:'shrol1xyz'},{address:7}])
  assert.equal(parseDepositFee({...fee,...bad}),undefined,JSON.stringify(bad));
 for(const junk of [undefined,null,'fee'])assert.equal(parseDepositFee(junk),undefined);
});

test('a stored or configured ceiling is read by the same number rules, and a zero one is a ceiling of no fee',()=>{
 assert.deepEqual(parseDepositFeeSchedule({fixedSats:0,bps:0,address:'never kept'}),{fixedSats:0,bps:0});
 assert.deepEqual(parseDepositFeeSchedule({fixedSats:100,bps:10_000}),{fixedSats:100,bps:10_000});
 for(const bad of [{fixedSats:1.5,bps:0},{fixedSats:-1,bps:0},{fixedSats:'5',bps:0},{fixedSats:2**53,bps:0},{fixedSats:0,bps:10_001},{fixedSats:0},null,'fee'])
  assert.equal(parseDepositFeeSchedule(bad),undefined,JSON.stringify(bad));
});

test('a wallet accepts a schedule no higher than the one it accepted, field by field',()=>{
 assert.equal(acceptsDepositFee({fixedSats:100,bps:25},{fixedSats:100,bps:25}),true);
 assert.equal(acceptsDepositFee({fixedSats:101,bps:1},{fixedSats:100,bps:25}),false);
 assert.equal(acceptsDepositFee({fixedSats:1,bps:26},{fixedSats:100,bps:25}),false);
 assert.equal(acceptsDepositFee(undefined,undefined),true);
 assert.equal(acceptsDepositFee({fixedSats:1,bps:0},undefined),false);
});

test('two tabs merge their accepted schedules upward',()=>{
 assert.deepEqual(maxDepositFeeOf({fixedSats:100,bps:0},{fixedSats:50,bps:30}),{fixedSats:100,bps:30});
 assert.deepEqual(maxDepositFeeOf(undefined,{fixedSats:50,bps:30}),{fixedSats:50,bps:30});
 assert.equal(maxDepositFeeOf(undefined,undefined),undefined);
});
