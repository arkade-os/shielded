pragma circom 2.1.6;
include "common.circom";
// data: intent[0..18],operation,old/new note/spent/history roots,old/new note/history counts.
template Transition() {
 signal input data[30]; signal input appendPaths[2][8]; signal input spentPath[8]; signal input historyPath[8]; signal input historyIndex; signal input sealPath[8];
 data[19]*(data[19]-1) === 0; signal apply; apply <== 1-data[19];
 component nz=IsZero(); nz.in <== data[2]; signal spend; spend <== apply*(1-nz.out);
 component nfBits=Num2Bits_strict(); nfBits.in <== data[2];
 component so=MerkleRoot(8); component sn=MerkleRoot(8); so.leaf <== 0; sn.leaf <== data[2];
 for(var i=0;i<8;i++) {so.bits[i] <== nfBits.out[i]; sn.bits[i] <== nfBits.out[i]; so.siblings[i] <== spentPath[i]; sn.siblings[i] <== spentPath[i];}
 spend*(so.root-data[22]) === 0; spend*(sn.root-data[23]) === 0; (1-spend)*(data[23]-data[22]) === 0;
 component hi=Num2Bits(8); hi.in <== historyIndex;
 component al=Poseidon(2); al.inputs[0] <== data[0]; al.inputs[1] <== data[1];
 component anchor=MerkleRoot(8); anchor.leaf <== al.out;
 for(var i=0;i<8;i++) {anchor.siblings[i] <== historyPath[i]; anchor.bits[i] <== hi.out[i];}
 spend*(anchor.root-data[24]) === 0;
 component within=LessThan(9); within.in[0] <== historyIndex; within.in[1] <== data[28]; spend*(within.out-1) === 0;
 signal noSpend; noSpend <== apply*nz.out; noSpend*data[1] === 0;
 component counts[4]; for(var i=0;i<4;i++) {counts[i]=Num2Bits(9); counts[i].in <== data[26+i];}
 data[27] === data[26]+2*apply; data[29] === data[28]+data[19];
 component bounds[2]; bounds[0]=LessEqThan(9); bounds[0].in[0] <== data[27]; bounds[0].in[1] <== 256; bounds[0].out === 1;
 bounds[1]=LessEqThan(9); bounds[1].in[0] <== data[29]; bounds[1].in[1] <== 256; bounds[1].out === 1;
 component ni[2]; component records[2]; component ao[2]; component an[2]; signal indices[2];
 for(var o=0;o<2;o++) {
  indices[o] <== apply*(data[26]+o); ni[o]=Num2Bits(8); ni[o].in <== indices[o];
  records[o]=Poseidon(8); records[o].inputs[0] <== data[3+o]; for(var i=0;i<7;i++) records[o].inputs[i+1] <== data[5+o*7+i];
  ao[o]=MerkleRoot(8); an[o]=MerkleRoot(8); ao[o].leaf <== 0; an[o].leaf <== records[o].out;
  for(var i=0;i<8;i++) {ao[o].siblings[i] <== appendPaths[o][i]; an[o].siblings[i] <== appendPaths[o][i]; ao[o].bits[i] <== ni[o].out[i]; an[o].bits[i] <== ni[o].out[i];}
 }
 apply*(ao[0].root-data[20]) === 0; apply*(ao[1].root-an[0].root) === 0; apply*(an[1].root-data[21]) === 0;
 data[19]*(data[21]-data[20]) === 0;
 component si=Num2Bits(8); si.in <== data[19]*data[28];
 component sl=Poseidon(2); sl.inputs[0] <== data[0]; sl.inputs[1] <== data[20];
 component ho=MerkleRoot(8); component hn=MerkleRoot(8); ho.leaf <== 0; hn.leaf <== sl.out;
 for(var i=0;i<8;i++) {ho.siblings[i] <== sealPath[i]; hn.siblings[i] <== sealPath[i]; ho.bits[i] <== si.out[i]; hn.bits[i] <== si.out[i];}
 data[19]*(ho.root-data[24]) === 0; data[19]*(hn.root-data[25]) === 0; apply*(data[25]-data[24]) === 0;
 for(var i=1;i<19;i++) data[19]*data[i] === 0;
}
component main {public [data]} = Transition();
