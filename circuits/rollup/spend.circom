pragma circom 2.1.6;
include "lib.circom";

// One input note (amount 0 = dummy, for deposits), two outputs, one asset.
// Public: pub (statement hash), then the boundary legs the covenant checks.
template Spend(DEPTH) {
 signal input pub; signal input deposit; signal input withdraw; signal input asset; signal input destination;
 signal input domain; signal input root; signal input ctDigest; signal input groupId; signal input groupSize;
 signal input inAmount; signal input inRho; signal input spendSecret;
 signal input path[DEPTH]; signal input bits[DEPTH];
 signal input outAmount[2]; signal input outOwner[2]; signal input outRandom[2];

 component range[5];
 for(var i=0;i<5;i++) range[i]=Num2Bits(64);
 range[0].in <== inAmount; range[1].in <== outAmount[0]; range[2].in <== outAmount[1];
 range[3].in <== deposit; range[4].in <== withdraw;

 component owner=Poseidon(2); owner.inputs[0] <== domain; owner.inputs[1] <== spendSecret;
 component note=Poseidon(5); note.inputs[0] <== domain; note.inputs[1] <== inAmount; note.inputs[2] <== asset;
 note.inputs[3] <== owner.out; note.inputs[4] <== inRho;
 component merkle=MerkleRoot(DEPTH); merkle.leaf <== note.out;
 for(var i=0;i<DEPTH;i++) { merkle.siblings[i] <== path[i]; merkle.bits[i] <== bits[i]; }
 component dummy=IsZero(); dummy.in <== inAmount;
 (merkle.root-root)*(1-dummy.out) === 0;
 component nf=Poseidon(3); nf.inputs[0] <== domain; nf.inputs[1] <== spendSecret; nf.inputs[2] <== inRho;

 component rho[2]; component cm[2];
 for(var o=0;o<2;o++) {
  rho[o]=Poseidon(4); rho[o].inputs[0] <== domain; rho[o].inputs[1] <== outRandom[o]; rho[o].inputs[2] <== nf.out; rho[o].inputs[3] <== o;
  cm[o]=Poseidon(5); cm[o].inputs[0] <== domain; cm[o].inputs[1] <== outAmount[o]; cm[o].inputs[2] <== asset;
  cm[o].inputs[3] <== outOwner[o]; cm[o].inputs[4] <== rho[o].out;
 }
 inAmount+deposit === outAmount[0]+outAmount[1]+withdraw;
 component noWithdraw=IsZero(); noWithdraw.in <== withdraw; noWithdraw.out*destination === 0;

 component statement=Poseidon(8);
 statement.inputs[0] <== domain; statement.inputs[1] <== root; statement.inputs[2] <== nf.out;
 statement.inputs[3] <== cm[0].out; statement.inputs[4] <== cm[1].out; statement.inputs[5] <== ctDigest;
 statement.inputs[6] <== groupId; statement.inputs[7] <== groupSize;
 statement.out === pub;
}
component main {public [pub, deposit, withdraw, asset, destination]} = Spend(32);
