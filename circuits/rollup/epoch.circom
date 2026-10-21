pragma circom 2.1.6;
include "lib.circom";

// nf is absent from a frozen indexed set: a leaf of it brackets nf. No count bound, as an unwritten slot is a literal 0.
template NonMember(D, TAG) {
 signal input nf; signal input root; signal input idx; signal input pred[3]; signal input path[D];
 component idxBits=Num2Bits(D); idxBits.in <== idx;
 component leaf=Poseidon(4);
 leaf.inputs[0] <== TAG; leaf.inputs[1] <== pred[0]; leaf.inputs[2] <== pred[1]; leaf.inputs[3] <== pred[2];
 component tree=MerkleRoot(D); tree.leaf <== leaf.out;
 for(var i=0;i<D;i++) { tree.bits[i] <== idxBits.out[i]; tree.siblings[i] <== path[i]; }
 tree.root === root;
 component lower=FieldLessThan(); lower.a <== pred[0]; lower.b <== nf; lower.out === 1;
 component nextZero=IsZero(); nextZero.in <== pred[1];
 component nextValueZero=IsZero(); nextValueZero.in <== pred[2];
 nextZero.out === nextValueZero.out;
 component upper=FieldLessThan(); upper.a <== nf; upper.b <== pred[2];
 (1-nextValueZero.out)*(upper.out-1) === 0;
}

// Rotates iff batchCount is a positive multiple of epochLen; the outputs are the trees a batch's slots run against.
template EpochRotation(DER, EMPTY_NOTE, EMPTY_NF) {
 var ER_TAG=20261020101;
 signal input batchCount; signal input batchQ; signal input epoch; signal input epochLen; signal input epochQ; signal input epochR; signal input noteRoot; signal input noteCount; signal input nfRoot; signal input nfCount; signal input rPrev; signal input prevNfRoot; signal input erRoot; signal input erCount; signal input erAppendPath[DER];
 signal output rotate; signal output rEpoch; signal output rPrevNote; signal output rPrevNf; signal output rNoteRoot; signal output rNoteCount; signal output rNfRoot; signal output rNfCount; signal output rErRoot; signal output rErCount; signal output winBits[6];
 component kBits=Num2Bits(6); kBits.in <== batchCount-batchQ*64;
 component qBits=Num2Bits(32); qBits.in <== batchQ; // 2^38 batches, where lib.circom's Batch allows 2^32
 component lenBits=Num2Bits(21); lenBits.in <== epochLen;
 component rBits=Num2Bits(21); rBits.in <== epochR;
 component qeBits=Num2Bits(32); qeBits.in <== epochQ; // epochQ*epochLen cannot wrap, so the remainder is unique
 component inRange=LessThan(21); inRange.in[0] <== epochR; inRange.in[1] <== epochLen; inRange.out === 1;
 batchCount === epochQ*epochLen+epochR;
 component rZero=IsZero(); rZero.in <== epochR;
 component fresh=IsZero(); fresh.in <== batchCount;
 rotate <== rZero.out*(1-fresh.out);
 erCount === epoch; // inductive already; asserted so "ER holds only epochs below c-1" needs no history (D2)
 component erBits=Num2Bits(DER); erBits.in <== erCount;
 component erLeaf=Poseidon(5);
 erLeaf.inputs[0] <== ER_TAG; erLeaf.inputs[1] <== epoch; erLeaf.inputs[2] <== rPrev;
 erLeaf.inputs[3] <== prevNfRoot; erLeaf.inputs[4] <== nfRoot;
 component erEmpty=MerkleRoot(DER); component erNew=MerkleRoot(DER);
 erEmpty.leaf <== 0; erNew.leaf <== erLeaf.out;
 for(var i=0;i<DER;i++) {
  erEmpty.bits[i] <== erBits.out[i]; erNew.bits[i] <== erBits.out[i];
  erEmpty.siblings[i] <== erAppendPath[i]; erNew.siblings[i] <== erAppendPath[i];
 }
 // Checked on every batch, not only a rotating one: a full archive has no empty slot, so it ends the pool (D4).
 erEmpty.root === erRoot;
 rPrevNote <== rPrev+rotate*(noteRoot-rPrev);
 rPrevNf <== prevNfRoot+rotate*(nfRoot-prevNfRoot);
 rNoteRoot <== noteRoot+rotate*(EMPTY_NOTE-noteRoot);
 rNoteCount <== noteCount-rotate*noteCount;
 rNfRoot <== nfRoot+rotate*(EMPTY_NF-nfRoot);
 rNfCount <== nfCount+rotate*(1-nfCount);
 rErRoot <== erRoot+rotate*(erNew.root-erRoot);
 rEpoch <== epoch+rotate; rErCount <== erCount+rotate;
 for(var j=0;j<6;j++) winBits[j] <== kBits.out[j];
}

// Batch with the two-tree anchor, per-epoch nullifier sets and the archive; rotation runs before any slot.
template EpochBatch(N, M, KIND, DOMAIN, Z, DNF, DER, EMPTY_NOTE, EMPTY_NF) {
 var D=32; var SUB=5; var WD=6; var NF_TAG=20261007301; var STATE_TAG=20261007001; var GROUP_TAG=20261007401;
 var WIN_TAG=20261020001; var EPOCH_TAG=20261020201; var RS_TAG=20261020301; var ANCHOR_TAG=20261020401;
 signal input pub[N]; signal input statement;
 signal input rCurRoot[N]; signal input rCurEpoch[N]; signal input nf[N][M]; signal input cm[N][2]; signal input ctDigest[N];
 signal input groupId[N]; signal input groupSize[N];
 signal input winIdx[N]; signal input winPath[N][WD];
 signal input predIdx[N*M]; signal input pred[N*M][3]; signal input predPath[N*M][DNF]; signal input appendPath[N*M][DNF];
 signal input nmIdx[N*M]; signal input nmLeaf[N*M][3]; signal input nmPath[N*M][DNF];
 signal input noteRoot; signal input noteCount; signal input noteSlot; signal input slotPath[D-SUB];
 signal input nfRoot; signal input nfCount;
 signal input winRoot; signal input batchCount; signal input batchQ; signal input winOldLeaf; signal input winSlotPath[WD];
 signal input rPrev; signal input prevNfRoot; signal input epoch; signal input epochLen; signal input epochQ; signal input epochR;
 signal input erRoot; signal input erCount; signal input erAppendPath[DER]; signal input rsRoot; signal input rsCount;

 component rot=EpochRotation(DER, EMPTY_NOTE, EMPTY_NF);
 rot.batchCount <== batchCount; rot.batchQ <== batchQ; rot.epoch <== epoch; rot.epochLen <== epochLen; rot.epochQ <== epochQ; rot.epochR <== epochR;
 rot.noteRoot <== noteRoot; rot.noteCount <== noteCount; rot.nfRoot <== nfRoot; rot.nfCount <== nfCount;
 rot.rPrev <== rPrev; rot.prevNfRoot <== prevNfRoot; rot.erRoot <== erRoot; rot.erCount <== erCount;
 for(var j=0;j<DER;j++) rot.erAppendPath[j] <== erAppendPath[j];

 component anchor[N]; component open[N]; component wLeaf[N]; component wBits[N]; component wTree[N]; component da[N]; component absent[N*M]; component ins[N*M];
 signal nfRoots[N*M+1]; signal daChain[N+1]; nfRoots[0] <== rot.rNfRoot; daChain[0] <== 0;
 for(var i=0;i<N;i++) {
  anchor[i]=Poseidon(3); anchor[i].inputs[0] <== ANCHOR_TAG; anchor[i].inputs[1] <== rot.rPrevNote; anchor[i].inputs[2] <== rCurRoot[i];
  open[i]=Poseidon(7+M);
  open[i].inputs[0] <== DOMAIN; open[i].inputs[1] <== anchor[i].out;
  for(var k=0;k<M;k++) open[i].inputs[2+k] <== nf[i][k];
  open[i].inputs[2+M] <== cm[i][0]; open[i].inputs[3+M] <== cm[i][1]; open[i].inputs[4+M] <== ctDigest[i];
  open[i].inputs[5+M] <== groupId[i]; open[i].inputs[6+M] <== groupSize[i];
  open[i].out === pub[i];

  wLeaf[i]=Poseidon(3); wLeaf[i].inputs[0] <== WIN_TAG; wLeaf[i].inputs[1] <== rCurEpoch[i]; wLeaf[i].inputs[2] <== rCurRoot[i];
  wBits[i]=Num2Bits(WD); wBits[i].in <== winIdx[i];
  wTree[i]=MerkleRoot(WD); wTree[i].leaf <== wLeaf[i].out;
  for(var j=0;j<WD;j++) { wTree[i].bits[j] <== wBits[i].out[j]; wTree[i].siblings[j] <== winPath[i][j]; }
  wTree[i].root === winRoot;
  // A window outlives an epoch shorter than 64 batches, so it can hold a c-2 root, whose spends NF[c-1] never saw.
  (rCurEpoch[i]-rot.rEpoch)*(rCurEpoch[i]-rot.rEpoch+1) === 0;

  for(var k=0;k<M;k++) {
   var s=i*M+k;
   absent[s]=NonMember(DNF, NF_TAG); absent[s].nf <== nf[i][k]; absent[s].root <== rot.rPrevNf; absent[s].idx <== nmIdx[s];
   for(var j=0;j<3;j++) absent[s].pred[j] <== nmLeaf[s][j];
   for(var j=0;j<DNF;j++) absent[s].path[j] <== nmPath[s][j];
   ins[s]=IndexedInsert(DNF, NF_TAG); ins[s].nf <== nf[i][k]; ins[s].count <== rot.rNfCount+s; ins[s].oldRoot <== nfRoots[s];
   ins[s].predIdx <== predIdx[s];
   for(var j=0;j<3;j++) ins[s].pred[j] <== pred[s][j];
   for(var j=0;j<DNF;j++) { ins[s].predPath[j] <== predPath[s][j]; ins[s].appendPath[j] <== appendPath[s][j]; }
   nfRoots[s+1] <== ins[s].newRoot;
  }

  da[i]=Poseidon(4+M); da[i].inputs[0] <== daChain[i];
  for(var k=0;k<M;k++) da[i].inputs[1+k] <== nf[i][k];
  da[i].inputs[1+M] <== cm[i][0]; da[i].inputs[2+M] <== cm[i][1]; da[i].inputs[3+M] <== ctDigest[i];
  daChain[i+1] <== da[i].out;
 }

 component groups=GroupRule(N, GROUP_TAG);
 for(var i=0;i<N;i++) { groups.groupId[i] <== groupId[i]; groups.groupSize[i] <== groupSize[i]; groups.first[i] <== nf[i][0]; }

 component append=AppendSubtree(2*N, SUB, D, Z);
 for(var i=0;i<N;i++) { append.leaves[2*i] <== cm[i][0]; append.leaves[2*i+1] <== cm[i][1]; }
 append.noteRoot <== rot.rNoteRoot; append.noteSlot <== noteSlot;
 for(var i=0;i<D-SUB;i++) append.slotPath[i] <== slotPath[i];
 rot.rNoteCount === noteSlot*(1<<SUB);

 component wNewLeaf=Poseidon(3); wNewLeaf.inputs[0] <== WIN_TAG; wNewLeaf.inputs[1] <== rot.rEpoch; wNewLeaf.inputs[2] <== append.newRoot;
 component wOld=MerkleRoot(WD); component wNew=MerkleRoot(WD);
 wOld.leaf <== winOldLeaf; wNew.leaf <== wNewLeaf.out;
 for(var j=0;j<WD;j++) {
  wOld.bits[j] <== rot.winBits[j]; wNew.bits[j] <== rot.winBits[j];
  wOld.siblings[j] <== winSlotPath[j]; wNew.siblings[j] <== winSlotPath[j];
 }
 wOld.root === winRoot;

 component oldEpoch=Poseidon(7); component newEpoch=Poseidon(7); component rs=Poseidon(3);
 oldEpoch.inputs[0] <== EPOCH_TAG; oldEpoch.inputs[1] <== epoch; oldEpoch.inputs[2] <== epochLen; oldEpoch.inputs[3] <== rPrev;
 oldEpoch.inputs[4] <== prevNfRoot; oldEpoch.inputs[5] <== erRoot; oldEpoch.inputs[6] <== erCount;
 newEpoch.inputs[0] <== EPOCH_TAG; newEpoch.inputs[1] <== rot.rEpoch; newEpoch.inputs[2] <== epochLen; newEpoch.inputs[3] <== rot.rPrevNote;
 newEpoch.inputs[4] <== rot.rPrevNf; newEpoch.inputs[5] <== rot.rErRoot; newEpoch.inputs[6] <== rot.rErCount;
 rs.inputs[0] <== RS_TAG; rs.inputs[1] <== rsRoot; rs.inputs[2] <== rsCount;

 component oldState=Poseidon(9); component newState=Poseidon(9);
 oldState.inputs[0] <== STATE_TAG; oldState.inputs[1] <== noteRoot; oldState.inputs[2] <== noteCount;
 oldState.inputs[3] <== nfRoot; oldState.inputs[4] <== nfCount; oldState.inputs[5] <== winRoot;
 oldState.inputs[6] <== batchCount; oldState.inputs[7] <== oldEpoch.out; oldState.inputs[8] <== rs.out;
 newState.inputs[0] <== STATE_TAG; newState.inputs[1] <== append.newRoot; newState.inputs[2] <== rot.rNoteCount+(1<<SUB);
 newState.inputs[3] <== nfRoots[N*M]; newState.inputs[4] <== rot.rNfCount+N*M; newState.inputs[5] <== wNew.root;
 newState.inputs[6] <== batchCount+1; newState.inputs[7] <== newEpoch.out; newState.inputs[8] <== rs.out;

 component bind=Binding(KIND, N);
 bind.fields[0] <== oldState.out; bind.fields[1] <== newState.out; bind.fields[2] <== daChain[N];
 bind.fields[3] <== append.subRoot;
 bind.statement === statement;
}
