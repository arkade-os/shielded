pragma circom 2.1.6;
template StockFieldLessThan() {
 signal input a; signal input b; signal output out;
 component ab=Num2Bits_strict(); component bb=Num2Bits_strict();
 ab.in <== a; bb.in <== b;
 signal same[254]; signal smaller[254]; signal equal[255]; signal less[255];
 equal[254] <== 1; less[254] <== 0;
 for(var i=253;i>=0;i--) {
  same[i] <== 1-ab.out[i]-bb.out[i]+2*ab.out[i]*bb.out[i];
  smaller[i] <== (1-ab.out[i])*bb.out[i];
  equal[i] <== equal[i+1]*same[i];
  less[i] <== less[i+1]+equal[i+1]*smaller[i];
 }
 out <== less[0];
}
template StockIndexedNullifier() {
 signal input nf; signal input active;
 signal input nfCount; signal input nfPredecessorIndex; signal input nfPredecessor[3];
 signal input nfPredecessorPath[9]; signal input nfAppendPath[9];
 signal output oldRoot; signal output newRoot;
 active*(active-1) === 0;
 component countBits=Num2Bits(10); countBits.in <== nfCount;
 component countZero=IsZero(); countZero.in <== nfCount; countZero.out === 0;
 component countBound=LessEqThan(10); countBound.in[0] <== nfCount; countBound.in[1] <== 512; countBound.out === 1;
 component room=LessThan(10); room.in[0] <== nfCount; room.in[1] <== 512; active*(room.out-1) === 0;
 component indexBits=Num2Bits(9); indexBits.in <== nfPredecessorIndex;
 component nextIndexBits=Num2Bits(9); nextIndexBits.in <== nfPredecessor[1];
 component predecessorBound=LessThan(10); predecessorBound.in[0] <== nfPredecessorIndex; predecessorBound.in[1] <== nfCount; predecessorBound.out === 1;
 component nextBound=LessThan(10); nextBound.in[0] <== nfPredecessor[1]; nextBound.in[1] <== nfCount; nextBound.out === 1;
 component nextZero=IsZero(); nextZero.in <== nfPredecessor[1];
 component nextValueZero=IsZero(); nextValueZero.in <== nfPredecessor[2];
 nextZero.out === nextValueZero.out;
 component lower=StockFieldLessThan(); lower.a <== nfPredecessor[0]; lower.b <== nf;
 active*(lower.out-1) === 0;
 component upper=StockFieldLessThan(); upper.a <== nf; upper.b <== nfPredecessor[2];
 signal needsUpper; needsUpper <== active*(1-nextZero.out);
 needsUpper*(upper.out-1) === 0;
 component predecessor=Poseidon(4); component updated=Poseidon(4); component inserted=Poseidon(4);
 predecessor.inputs[0] <== 20260930302; updated.inputs[0] <== 20260930302; inserted.inputs[0] <== 20260930302;
 predecessor.inputs[1] <== nfPredecessor[0]; predecessor.inputs[2] <== nfPredecessor[1]; predecessor.inputs[3] <== nfPredecessor[2];
 updated.inputs[1] <== nfPredecessor[0]; updated.inputs[2] <== nfCount; updated.inputs[3] <== nf;
 inserted.inputs[1] <== nf; inserted.inputs[2] <== nfPredecessor[1]; inserted.inputs[3] <== nfPredecessor[2];
 component oldTree=MerkleRoot(9); component middleTree=MerkleRoot(9);
 oldTree.leaf <== predecessor.out; middleTree.leaf <== updated.out;
 for(var i=0;i<9;i++) {
  oldTree.bits[i] <== indexBits.out[i]; middleTree.bits[i] <== indexBits.out[i];
  oldTree.siblings[i] <== nfPredecessorPath[i]; middleTree.siblings[i] <== nfPredecessorPath[i];
 }
 component appendBits=Num2Bits(9); appendBits.in <== active*nfCount;
 component emptyAppend=MerkleRoot(9); component newTree=MerkleRoot(9);
 emptyAppend.leaf <== 0; newTree.leaf <== inserted.out;
 for(var i=0;i<9;i++) {
  emptyAppend.bits[i] <== appendBits.out[i]; newTree.bits[i] <== appendBits.out[i];
  emptyAppend.siblings[i] <== nfAppendPath[i]; newTree.siblings[i] <== nfAppendPath[i];
 }
 active*(emptyAppend.root-middleTree.root) === 0;
 component oldCommit=Poseidon(3); component newCommit=Poseidon(3);
 oldCommit.inputs[0] <== 20260930302; newCommit.inputs[0] <== 20260930302;
 oldCommit.inputs[1] <== oldTree.root; oldCommit.inputs[2] <== nfCount;
 newCommit.inputs[1] <== newTree.root; newCommit.inputs[2] <== nfCount+1;
 oldRoot <== oldCommit.out;
 newRoot <== oldCommit.out+active*(newCommit.out-oldCommit.out);
}