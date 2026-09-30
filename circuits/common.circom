pragma circom 2.1.6;
include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/babyjub.circom";
include "../node_modules/circomlib/circuits/escalarmulany.circom";
template MerkleRoot(depth) {
 signal input leaf; signal input siblings[depth]; signal input bits[depth]; signal output root;
 signal nodes[depth+1]; component h[depth]; nodes[0] <== leaf;
 for(var i=0;i<depth;i++) {
  bits[i]*(bits[i]-1) === 0; h[i]=Poseidon(2);
  h[i].inputs[0] <== nodes[i]+bits[i]*(siblings[i]-nodes[i]);
  h[i].inputs[1] <== siblings[i]+bits[i]*(nodes[i]-siblings[i]); nodes[i+1] <== h[i].out;
 } root <== nodes[depth];
}
template EncryptedNote() {
 signal input domain; signal input amount; signal input asset; signal input owner; signal input rho;
 signal input recipient[2]; signal input recipientPreimage[2]; signal input ephemeral; signal output ciphertext[7];
 component check=BabyCheck(); check.x <== recipient[0]; check.y <== recipient[1];
 component preCheck=BabyCheck(); preCheck.x <== recipientPreimage[0]; preCheck.y <== recipientPreimage[1];
 component dbl[3]; component dblCheck[3];
 for(var i=0;i<3;i++) {
  dbl[i]=BabyDbl(); dblCheck[i]=BabyCheck();
  if(i==0) {dbl[i].x <== recipientPreimage[0]; dbl[i].y <== recipientPreimage[1];}
  else {dbl[i].x <== dbl[i-1].xout; dbl[i].y <== dbl[i-1].yout;}
  dblCheck[i].x <== dbl[i].xout; dblCheck[i].y <== dbl[i].yout;
 }
 dbl[2].xout === recipient[0]; dbl[2].yout === recipient[1];
 component nz=IsZero(); nz.in <== recipient[0]; nz.out === 0;
 component eb=Num2Bits(252); eb.in <== ephemeral;
 component scalarBound=LessThan(252); scalarBound.in[0] <== ephemeral; scalarBound.in[1] <== 2736030358979909402780800718157159386076813972158567259200215660948447373041; scalarBound.out === 1;
 component ez=IsZero(); ez.in <== ephemeral; ez.out === 0;
 component pub=BabyPbk(); pub.in <== ephemeral; ciphertext[0] <== pub.Ax; ciphertext[1] <== pub.Ay;
 component shared=EscalarMulAny(252); shared.p[0] <== recipient[0]; shared.p[1] <== recipient[1];
 for(var i=0;i<252;i++) shared.e[i] <== eb.out[i];
 component masks[4]; signal plain[4]; plain[0] <== amount; plain[1] <== asset; plain[2] <== owner; plain[3] <== rho;
 for(var i=0;i<4;i++) {
  masks[i]=Poseidon(4); masks[i].inputs[0] <== domain; masks[i].inputs[1] <== shared.out[0];
  masks[i].inputs[2] <== shared.out[1]; masks[i].inputs[3] <== i+100;
  ciphertext[2+i] <== plain[i]+masks[i].out;
 }
 component mac=Poseidon(8); mac.inputs[0] <== domain; mac.inputs[1] <== shared.out[0]; mac.inputs[2] <== shared.out[1];
 for(var i=0;i<4;i++) mac.inputs[i+3] <== ciphertext[i+2];
 mac.inputs[7] <== 200; ciphertext[6] <== mac.out;
}
