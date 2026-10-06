template StockTransition() {
 signal input data[30]; signal input outputAmount[2]; signal input modeWithdraw;
 signal input appendPaths[2][8]; signal input historyPath[8]; signal input historyIndex; signal input sealPath[8];
 signal input nfCount; signal input nfPredecessorIndex; signal input nfPredecessor[3];
 signal input nfPredecessorPath[9]; signal input nfAppendPath[9];
 signal input lastSealedRoot; signal input lastSealPath[8];
 data[19]*(data[19]-1) === 0; signal apply; apply <== 1-data[19];
 component nz=IsZero(); nz.in <== data[2]; signal spend; spend <== apply*(1-nz.out);
 component indexed=StockIndexedNullifier(); indexed.nf <== data[2]; indexed.active <== spend;
 indexed.nfCount <== nfCount; indexed.nfPredecessorIndex <== nfPredecessorIndex;
 for(var i=0;i<3;i++) indexed.nfPredecessor[i] <== nfPredecessor[i];
 for(var i=0;i<9;i++) { indexed.nfPredecessorPath[i] <== nfPredecessorPath[i]; indexed.nfAppendPath[i] <== nfAppendPath[i]; }
 indexed.oldRoot === data[22]; indexed.newRoot === data[23];
 component nfBits=Num2Bits_strict(); nfBits.in <== data[2];
 component hi=Num2Bits(8); hi.in <== historyIndex;
 component al=Poseidon(2); al.inputs[0] <== data[0]; al.inputs[1] <== data[1];
 component anchor=MerkleRoot(8); anchor.leaf <== al.out;
 for(var i=0;i<8;i++) { anchor.siblings[i] <== historyPath[i]; anchor.bits[i] <== hi.out[i]; }
 spend*(anchor.root-data[24]) === 0;
 component within=LessThan(9); within.in[0] <== historyIndex; within.in[1] <== data[28]; spend*(within.out-1) === 0;
 signal noSpend; noSpend <== apply*nz.out; noSpend*data[1] === 0;
 component counts[4]; for(var i=0;i<4;i++) { counts[i]=Num2Bits(9); counts[i].in <== data[26+i]; }
 counts[0].out[0] === 0; counts[1].out[0] === 0;
 component noteBounds[2]; noteBounds[0]=LessEqThan(9); noteBounds[0].in[0] <== data[26]; noteBounds[0].in[1] <== 256; noteBounds[0].out === 1;
 noteBounds[1]=LessEqThan(9); noteBounds[1].in[0] <== data[27]; noteBounds[1].in[1] <== 256; noteBounds[1].out === 1;
 component historyBounds[2]; historyBounds[0]=LessEqThan(9); historyBounds[0].in[0] <== data[28]; historyBounds[0].in[1] <== 256; historyBounds[0].out === 1;
 historyBounds[1]=LessEqThan(9); historyBounds[1].in[0] <== data[29]; historyBounds[1].in[1] <== 256; historyBounds[1].out === 1;
 component sumZero=IsZero(); sumZero.in <== outputAmount[0]+outputAmount[1];
 signal withdrawApply; signal freeExit; signal appendTx;
 withdrawApply <== apply*modeWithdraw;
 freeExit <== withdrawApply*sumZero.out;
 appendTx <== apply*(1-freeExit);
 data[27] === data[26]+2*appendTx;
 data[29] === data[28]+data[19];
 component noteTreesOld[2]; component noteTreesNew[2]; component records[2]; component noteIndexBits[2]; signal indices[2];
 for(var o=0;o<2;o++) {
  indices[o] <== appendTx*(data[26]+o); noteIndexBits[o]=Num2Bits(8); noteIndexBits[o].in <== indices[o];
  records[o]=Poseidon(8); records[o].inputs[0] <== data[3+o];
  for(var i=0;i<7;i++) records[o].inputs[i+1] <== data[5+o*7+i];
  noteTreesOld[o]=MerkleRoot(8); noteTreesNew[o]=MerkleRoot(8);
  noteTreesOld[o].leaf <== 0; noteTreesNew[o].leaf <== records[o].out;
  for(var i=0;i<8;i++) {
   noteTreesOld[o].siblings[i] <== appendPaths[o][i]; noteTreesNew[o].siblings[i] <== appendPaths[o][i];
   noteTreesOld[o].bits[i] <== noteIndexBits[o].out[i]; noteTreesNew[o].bits[i] <== noteIndexBits[o].out[i];
  }
 }
 appendTx*(noteTreesOld[0].root-data[20]) === 0;
 appendTx*(noteTreesOld[1].root-noteTreesNew[0].root) === 0;
 appendTx*(noteTreesNew[1].root-data[21]) === 0;
 (1-appendTx)*(data[21]-data[20]) === 0;
 component si=Num2Bits(8); si.in <== data[19]*data[28];
 component sl=Poseidon(2); sl.inputs[0] <== data[0]; sl.inputs[1] <== data[20];
 component ho=MerkleRoot(8); component hn=MerkleRoot(8); ho.leaf <== 0; hn.leaf <== sl.out;
 for(var i=0;i<8;i++) { ho.siblings[i] <== sealPath[i]; hn.siblings[i] <== sealPath[i]; ho.bits[i] <== si.out[i]; hn.bits[i] <== si.out[i]; }
 data[19]*(ho.root-data[24]) === 0; data[19]*(hn.root-data[25]) === 0;
 (1-data[19])*(data[25]-data[24]) === 0;
 component historyZero=IsZero(); historyZero.in <== data[28];
 signal hasPrevious; hasPrevious <== 1-historyZero.out;
 signal priorIndex; priorIndex <== data[28]-hasPrevious;
 component priorIndexBits=Num2Bits(8); priorIndexBits.in <== priorIndex;
 component lastAnchor=Poseidon(2); lastAnchor.inputs[0] <== data[0]; lastAnchor.inputs[1] <== lastSealedRoot;
 component lastTree=MerkleRoot(8); lastTree.leaf <== lastAnchor.out;
 for(var i=0;i<8;i++) { lastTree.bits[i] <== priorIndexBits.out[i]; lastTree.siblings[i] <== lastSealPath[i]; }
 signal sealPrior; sealPrior <== data[19]*hasPrevious;
 sealPrior*(lastTree.root-data[24]) === 0;
 component noNotes=IsZero(); noNotes.in <== data[26]; data[19]*noNotes.out === 0;
 component sameRoot=IsZero(); sameRoot.in <== lastSealedRoot-data[20];
 sealPrior*sameRoot.out === 0;
 for(var i=1;i<19;i++) data[19]*data[i] === 0;
}
