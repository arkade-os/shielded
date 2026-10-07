pragma circom 2.1.6;
include "lib.circom";

// Two input notes, two outputs, one asset: consolidation, splitting and pay-from-two.
template Join(DEPTH) {
 signal input pub; signal input deposit; signal input withdraw; signal input asset; signal input destination;
 signal input domain; signal input root; signal input ctDigest; signal input groupId; signal input groupSize;
 signal input inAmount[2]; signal input inRho[2]; signal input spendSecret[2];
 signal input path[2][DEPTH]; signal input bits[2][DEPTH];
 signal input outAmount[2]; signal input outOwner[2]; signal input outRandom[2];

 component range[6];
 for(var i=0;i<6;i++) range[i]=Num2Bits(64);
 range[0].in <== inAmount[0]; range[1].in <== inAmount[1]; range[2].in <== outAmount[0];
 range[3].in <== outAmount[1]; range[4].in <== deposit; range[5].in <== withdraw;

 component owner[2]; component note[2]; component merkle[2]; component dummy[2]; component nf[2];
 for(var k=0;k<2;k++) {
  owner[k]=Poseidon(2); owner[k].inputs[0] <== domain; owner[k].inputs[1] <== spendSecret[k];
  note[k]=Poseidon(5); note[k].inputs[0] <== domain; note[k].inputs[1] <== inAmount[k]; note[k].inputs[2] <== asset;
  note[k].inputs[3] <== owner[k].out; note[k].inputs[4] <== inRho[k];
  merkle[k]=MerkleRoot(DEPTH); merkle[k].leaf <== note[k].out;
  for(var i=0;i<DEPTH;i++) { merkle[k].siblings[i] <== path[k][i]; merkle[k].bits[i] <== bits[k][i]; }
  dummy[k]=IsZero(); dummy[k].in <== inAmount[k];
  (merkle[k].root-root)*(1-dummy[k].out) === 0;
  nf[k]=Poseidon(3); nf[k].inputs[0] <== domain; nf[k].inputs[1] <== spendSecret[k]; nf[k].inputs[2] <== inRho[k];
 }
 component distinct=IsZero(); distinct.in <== nf[0].out-nf[1].out; distinct.out === 0;

 component rho[2]; component cm[2];
 for(var o=0;o<2;o++) {
  rho[o]=Poseidon(5); rho[o].inputs[0] <== domain; rho[o].inputs[1] <== outRandom[o];
  rho[o].inputs[2] <== nf[0].out; rho[o].inputs[3] <== nf[1].out; rho[o].inputs[4] <== o;
  cm[o]=Poseidon(5); cm[o].inputs[0] <== domain; cm[o].inputs[1] <== outAmount[o]; cm[o].inputs[2] <== asset;
  cm[o].inputs[3] <== outOwner[o]; cm[o].inputs[4] <== rho[o].out;
 }
 inAmount[0]+inAmount[1]+deposit === outAmount[0]+outAmount[1]+withdraw;
 component noWithdraw=IsZero(); noWithdraw.in <== withdraw; noWithdraw.out*destination === 0;

 component statement=Poseidon(9);
 statement.inputs[0] <== domain; statement.inputs[1] <== root; statement.inputs[2] <== nf[0].out;
 statement.inputs[3] <== nf[1].out; statement.inputs[4] <== cm[0].out; statement.inputs[5] <== cm[1].out;
 statement.inputs[6] <== ctDigest; statement.inputs[7] <== groupId; statement.inputs[8] <== groupSize;
 statement.out === pub;
}
component main {public [pub, deposit, withdraw, asset, destination]} = Join(32);
