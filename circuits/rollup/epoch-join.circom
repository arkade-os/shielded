pragma circom 2.1.6;
include "lib.circom";

// Two input notes, two outputs, one asset: consolidation, splitting and pay-from-two.
template EpochJoin(DEPTH) {
 signal input pub; signal input nf0; signal input nf1; signal input deposit; signal input withdraw; signal input boundaryAsset; signal input destination;
 signal input domain; signal input rPrev; signal input rCur; signal input sel[2]; signal input ctDigest; signal input groupId; signal input groupSize; signal input asset;
 signal input inAmount[2]; signal input inRho[2]; signal input ask[2]; signal input nk[2];
 signal input path[2][DEPTH]; signal input bits[2][DEPTH];
 signal input outAmount[2]; signal input outOwner[2]; signal input outRandom[2];

 component range[6];
 for(var i=0;i<6;i++) range[i]=Num2Bits(64);
 range[0].in <== inAmount[0]; range[1].in <== inAmount[1]; range[2].in <== outAmount[0];
 range[3].in <== outAmount[1]; range[4].in <== deposit; range[5].in <== withdraw;

 var DUMMY_TAG=20261009301, AK_TAG=20261009101; component ak[2]; component owner[2]; component note[2]; component merkle[2]; component dummy[2]; component nf[2];
 signal anchorRoot[2];
 for(var k=0;k<2;k++) {
  ak[k]=Poseidon(2); ak[k].inputs[0] <== AK_TAG; ak[k].inputs[1] <== ask[k]; owner[k]=Poseidon(3); owner[k].inputs[0] <== domain; owner[k].inputs[1] <== ak[k].out; owner[k].inputs[2] <== nk[k];
  note[k]=Poseidon(5); note[k].inputs[0] <== domain; note[k].inputs[1] <== inAmount[k]; note[k].inputs[2] <== asset;
  note[k].inputs[3] <== owner[k].out; note[k].inputs[4] <== inRho[k];
  merkle[k]=MerkleRoot(DEPTH); merkle[k].leaf <== note[k].out;
  for(var i=0;i<DEPTH;i++) { merkle[k].siblings[i] <== path[k][i]; merkle[k].bits[i] <== bits[k][i]; }
  dummy[k]=IsZero(); dummy[k].in <== inAmount[k];
  // Unconditional, a dummy included: sel = (T-rCur)/(rPrev-rCur) puts any root T on the mux.
  sel[k]*(sel[k]-1) === 0;
  anchorRoot[k] <== rCur+sel[k]*(rPrev-rCur);
  (merkle[k].root-anchorRoot[k])*(1-dummy[k].out) === 0;
  nf[k]=Poseidon(3); nf[k].inputs[0] <== domain+dummy[k].out*(DUMMY_TAG-domain); nf[k].inputs[1] <== nk[k]; nf[k].inputs[2] <== inRho[k];
 }
 var ANCHOR_TAG=20261020401; component anchor=Poseidon(3); anchor.inputs[0] <== ANCHOR_TAG; anchor.inputs[1] <== rPrev; anchor.inputs[2] <== rCur;
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
 component noLeg=IsZero(); noLeg.in <== deposit+withdraw; boundaryAsset === asset*(1-noLeg.out);

 component statement=Poseidon(9);
 statement.inputs[0] <== domain; statement.inputs[1] <== anchor.out; statement.inputs[2] <== nf[0].out;
 statement.inputs[3] <== nf[1].out; statement.inputs[4] <== cm[0].out; statement.inputs[5] <== cm[1].out;
 statement.inputs[6] <== ctDigest; statement.inputs[7] <== groupId; statement.inputs[8] <== groupSize;
 statement.out === pub;
 // The chain carries both nullifiers, so they must be these notes'.
 nf[0].out === nf0; nf[1].out === nf1;
}
component main {public [pub, nf0, nf1, deposit, withdraw, boundaryAsset, destination]} = EpochJoin(32);
