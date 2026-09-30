pragma circom 2.1.6;
include "common.circom";
// data: domain,anchor,nf,cm[2],cipher[2][7],deposit[2],withdrawal[2],destination,nonce.
template Intent() {
 signal input data[25]; signal input inputAmount; signal input inputAsset; signal input inputRho; signal input spendSecret;
 signal input inputCipher[7]; signal input inputPath[8]; signal input inputBits[8];
 signal input outputAmount[2]; signal input outputAsset[2]; signal input outputOwner[2]; signal input outputRandom[2];
 signal input recipient[2][2]; signal input recipientPreimage[2][2]; signal input ephemeral[2];
 component ia=Num2Bits(48); ia.in <== inputAmount; inputAsset*(inputAsset-1) === 0;
 component zero=IsZero(); zero.in <== inputAmount; signal active; active <== 1-zero.out;
 component owner=Poseidon(2); owner.inputs[0] <== data[0]; owner.inputs[1] <== spendSecret;
 component note=Poseidon(5); note.inputs[0] <== data[0]; note.inputs[1] <== inputAmount; note.inputs[2] <== inputAsset;
 note.inputs[3] <== owner.out; note.inputs[4] <== inputRho;
 component record=Poseidon(8); record.inputs[0] <== note.out;
 for(var i=0;i<7;i++) record.inputs[i+1] <== inputCipher[i];
 component membership=MerkleRoot(8); membership.leaf <== record.out;
 for(var i=0;i<8;i++) {membership.siblings[i] <== inputPath[i]; membership.bits[i] <== inputBits[i];}
 active*(membership.root-data[1]) === 0; zero.out*data[1] === 0;
 component nf=Poseidon(3); nf.inputs[0] <== data[0]; nf.inputs[1] <== spendSecret; nf.inputs[2] <== inputRho;
 data[2] === active*nf.out;
 component nfzero=IsZero(); nfzero.in <== data[2]; active*nfzero.out === 0;
 component oa[2]; component rho[2]; component cm[2]; component enc[2];
 for(var o=0;o<2;o++) {
  oa[o]=Num2Bits(48); oa[o].in <== outputAmount[o]; outputAsset[o]*(outputAsset[o]-1) === 0;
  rho[o]=Poseidon(4); rho[o].inputs[0] <== data[0]; rho[o].inputs[1] <== outputRandom[o]; rho[o].inputs[2] <== data[23]; rho[o].inputs[3] <== data[24];
  cm[o]=Poseidon(5); cm[o].inputs[0] <== data[0]; cm[o].inputs[1] <== outputAmount[o]; cm[o].inputs[2] <== outputAsset[o];
  cm[o].inputs[3] <== outputOwner[o]; cm[o].inputs[4] <== rho[o].out; cm[o].out === data[3+o];
  enc[o]=EncryptedNote(); enc[o].domain <== data[0]; enc[o].amount <== outputAmount[o]; enc[o].asset <== outputAsset[o];
  enc[o].owner <== outputOwner[o]; enc[o].rho <== rho[o].out; enc[o].recipient[0] <== recipient[o][0]; enc[o].recipient[1] <== recipient[o][1]; enc[o].ephemeral <== ephemeral[o]; enc[o].recipientPreimage[0] <== recipientPreimage[o][0]; enc[o].recipientPreimage[1] <== recipientPreimage[o][1];
  for(var i=0;i<7;i++) enc[o].ciphertext[i] === data[5+o*7+i];
 }
 component bs[4]; for(var i=0;i<4;i++) {bs[i]=Num2Bits(48); bs[i].in <== data[19+i];}
 signal ib; signal it; signal ob[2]; signal ot[2]; ib <== inputAmount*(1-inputAsset); it <== inputAmount*inputAsset;
 for(var i=0;i<2;i++) {ob[i] <== outputAmount[i]*(1-outputAsset[i]); ot[i] <== outputAmount[i]*outputAsset[i];}
 ib+data[19] === ob[0]+ob[1]+data[21]; it+data[20] === ot[0]+ot[1]+data[22];
}
component main {public [data]} = Intent();
