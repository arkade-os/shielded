pragma circom 2.1.6;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/sha256/sha256.circom";

template MerkleRoot(depth) {
 signal input leaf; signal input siblings[depth]; signal input bits[depth]; signal output root;
 signal nodes[depth+1]; component h[depth]; nodes[0] <== leaf;
 for(var i=0;i<depth;i++) {
  bits[i]*(bits[i]-1) === 0; h[i]=Poseidon(2);
  h[i].inputs[0] <== nodes[i]+bits[i]*(siblings[i]-nodes[i]);
  h[i].inputs[1] <== siblings[i]+bits[i]*(nodes[i]-siblings[i]); nodes[i+1] <== h[i].out;
 }
 root <== nodes[depth];
}

template FieldLessThan() {
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

// Sorted linked-list insertion into a depth-D indexed tree; leaf = Poseidon(TAG, value, nextIndex, nextValue).
template IndexedInsert(D, TAG) {
 signal input nf; signal input count; signal input oldRoot;
 signal input predIdx; signal input pred[3]; signal input predPath[D]; signal input appendPath[D];
 signal output newRoot;
 component countBits=Num2Bits(D); countBits.in <== count;
 component countZero=IsZero(); countZero.in <== count; countZero.out === 0;
 component idxBits=Num2Bits(D); idxBits.in <== predIdx;
 component nextBits=Num2Bits(D); nextBits.in <== pred[1];
 component predBound=LessThan(D+1); predBound.in[0] <== predIdx; predBound.in[1] <== count; predBound.out === 1;
 component nextBound=LessThan(D+1); nextBound.in[0] <== pred[1]; nextBound.in[1] <== count; nextBound.out === 1;
 component nextZero=IsZero(); nextZero.in <== pred[1];
 component nextValueZero=IsZero(); nextValueZero.in <== pred[2];
 nextZero.out === nextValueZero.out;
 component lower=FieldLessThan(); lower.a <== pred[0]; lower.b <== nf; lower.out === 1;
 component upper=FieldLessThan(); upper.a <== nf; upper.b <== pred[2];
 (1-nextZero.out)*(upper.out-1) === 0;
 component predecessor=Poseidon(4); component updated=Poseidon(4); component inserted=Poseidon(4);
 predecessor.inputs[0] <== TAG; predecessor.inputs[1] <== pred[0]; predecessor.inputs[2] <== pred[1]; predecessor.inputs[3] <== pred[2];
 updated.inputs[0] <== TAG; updated.inputs[1] <== pred[0]; updated.inputs[2] <== count; updated.inputs[3] <== nf;
 inserted.inputs[0] <== TAG; inserted.inputs[1] <== nf; inserted.inputs[2] <== pred[1]; inserted.inputs[3] <== pred[2];
 component oldTree=MerkleRoot(D); component middleTree=MerkleRoot(D);
 component emptyAppend=MerkleRoot(D); component newTree=MerkleRoot(D);
 oldTree.leaf <== predecessor.out; middleTree.leaf <== updated.out;
 emptyAppend.leaf <== 0; newTree.leaf <== inserted.out;
 for(var i=0;i<D;i++) {
  oldTree.bits[i] <== idxBits.out[i]; middleTree.bits[i] <== idxBits.out[i];
  oldTree.siblings[i] <== predPath[i]; middleTree.siblings[i] <== predPath[i];
  emptyAppend.bits[i] <== countBits.out[i]; newTree.bits[i] <== countBits.out[i];
  emptyAppend.siblings[i] <== appendPath[i]; newTree.siblings[i] <== appendPath[i];
 }
 oldTree.root === oldRoot;
 emptyAppend.root === middleTree.root;
 newRoot <== newTree.root;
}

// The batch's 2N commitments as one zero-padded 2^SUB subtree, spliced into the empty aligned slot.
template AppendSubtree(L, SUB, D, Z) {
 signal input leaves[L]; signal input noteRoot; signal input noteSlot; signal input slotPath[D-SUB];
 signal output newRoot;
 var W=1<<SUB;
 signal lvl[SUB+1][W]; component h[SUB+1][W];
 for(var j=0;j<W;j++) { if(j<L) lvl[0][j] <== leaves[j]; else lvl[0][j] <== 0; }
 for(var l=1;l<=SUB;l++) for(var j=0;j<(W>>l);j++) {
  if(j*(1<<l)<L) {
   h[l][j]=Poseidon(2); h[l][j].inputs[0] <== lvl[l-1][2*j]; h[l][j].inputs[1] <== lvl[l-1][2*j+1];
   lvl[l][j] <== h[l][j].out;
  } else lvl[l][j] <== Z[l];
 }
 component slotBits=Num2Bits(D-SUB); slotBits.in <== noteSlot;
 component oldSlot=MerkleRoot(D-SUB); component newSlot=MerkleRoot(D-SUB);
 oldSlot.leaf <== Z[SUB]; newSlot.leaf <== lvl[SUB][0];
 for(var i=0;i<D-SUB;i++) {
  oldSlot.bits[i] <== slotBits.out[i]; newSlot.bits[i] <== slotBits.out[i];
  oldSlot.siblings[i] <== slotPath[i]; newSlot.siblings[i] <== slotPath[i];
 }
 oldSlot.root === noteRoot;
 newRoot <== newSlot.root;
}

// sha256-le-248 of: 'S' 'H' 2 KIND N || old state || new state || DA root (fields as 32 LE bytes).
template Binding(KIND, N) {
 signal input fields[3]; signal output statement;
 var magic[5]=[83,72,2,KIND,N];
 component sha=Sha256(101*8); component fb[3];
 for(var i=0;i<5;i++) for(var b=0;b<8;b++) sha.in[i*8+b] <== (magic[i]>>(7-b))&1;
 for(var f=0;f<3;f++) {
  fb[f]=Num2Bits_strict(); fb[f].in <== fields[f];
  for(var i=0;i<32;i++) for(var b=0;b<8;b++) {
   if(i*8+7-b<254) sha.in[(5+32*f+i)*8+b] <== fb[f].out[i*8+7-b];
   else sha.in[(5+32*f+i)*8+b] <== 0;
  }
 }
 var sv=0;
 for(var i=0;i<31;i++) for(var b=0;b<8;b++) sv += sha.out[i*8+b]*(2**(8*i+7-b));
 statement <== sv;
}

// Atomic groups: a group of size 2 or 3 occupies a run of consecutive slots
// whose id is Poseidon(TAG, first nullifier of each member, padded with 0).
template GroupRule(N, TAG) {
 signal input groupId[N]; signal input groupSize[N]; signal input first[N];
 component idZero[N]; component e2[N]; component e3[N]; component sameEq[N]; component h[N];
 signal is2[N]; signal is3[N]; signal same[N+1]; signal start[N]; signal s2[N]; signal s3[N]; signal third[N];
 same[0] <== 0; same[N] <== 0;
 for(var i=0;i<N;i++) {
  idZero[i]=IsZero(); idZero[i].in <== groupId[i];
  e2[i]=IsEqual(); e2[i].in[0] <== groupSize[i]; e2[i].in[1] <== 2; is2[i] <== e2[i].out;
  e3[i]=IsEqual(); e3[i].in[0] <== groupSize[i]; e3[i].in[1] <== 3; is3[i] <== e3[i].out;
  groupSize[i] === 2*is2[i]+3*is3[i];
  idZero[i].out === 1-is2[i]-is3[i];
  if(i>0) {
   sameEq[i]=IsEqual(); sameEq[i].in[0] <== groupId[i]; sameEq[i].in[1] <== groupId[i-1]; same[i] <== sameEq[i].out;
   same[i]*(groupSize[i]-groupSize[i-1]) === 0;
  }
 }
 for(var i=0;i<N;i++) {
  start[i] <== (1-idZero[i].out)*(1-same[i]);
  s2[i] <== start[i]*is2[i]; s3[i] <== start[i]*is3[i];
  if(i+1<N) { (s2[i]+s3[i])*(same[i+1]-1) === 0; } else { s2[i]+s3[i] === 0; }
  if(i+2<N) { s2[i]*same[i+2] === 0; s3[i]*(same[i+2]-1) === 0; } else { s3[i] === 0; }
  if(i+3<N) { s3[i]*same[i+3] === 0; }
  h[i]=Poseidon(4); h[i].inputs[0] <== TAG; h[i].inputs[1] <== first[i];
  if(i+1<N) h[i].inputs[2] <== first[i+1]; else h[i].inputs[2] <== 0;
  if(i+2<N) third[i] <== is3[i]*first[i+2]; else third[i] <== 0;
  h[i].inputs[3] <== third[i];
  start[i]*(groupId[i]-h[i].out) === 0;
 }
}

// One batch of N slots, each spending M notes (M=1 spend, M=2 join).
template Batch(N, M, KIND, DOMAIN, Z) {
 var D=32; var SUB=5; var WD=6; var NF_TAG=20261007301; var STATE_TAG=20261007001; var GROUP_TAG=20261007401;
 signal input pub[N]; signal input statement;
 signal input root[N]; signal input nf[N][M]; signal input cm[N][2]; signal input ctDigest[N];
 signal input groupId[N]; signal input groupSize[N];
 signal input winIdx[N]; signal input winPath[N][WD];
 signal input predIdx[N*M]; signal input pred[N*M][3]; signal input predPath[N*M][D]; signal input appendPath[N*M][D];
 signal input noteRoot; signal input noteCount; signal input noteSlot; signal input slotPath[D-SUB];
 signal input nfRoot; signal input nfCount;
 signal input winRoot; signal input batchCount; signal input batchQ; signal input winOldLeaf; signal input winSlotPath[WD];

 component open[N]; component wBits[N]; component wTree[N]; component da[N]; component ins[N*M];
 signal nfRoots[N*M+1]; signal daChain[N+1]; nfRoots[0] <== nfRoot; daChain[0] <== 0;
 for(var i=0;i<N;i++) {
  open[i]=Poseidon(7+M);
  open[i].inputs[0] <== DOMAIN; open[i].inputs[1] <== root[i];
  for(var k=0;k<M;k++) open[i].inputs[2+k] <== nf[i][k];
  open[i].inputs[2+M] <== cm[i][0]; open[i].inputs[3+M] <== cm[i][1]; open[i].inputs[4+M] <== ctDigest[i];
  open[i].inputs[5+M] <== groupId[i]; open[i].inputs[6+M] <== groupSize[i];
  open[i].out === pub[i];

  wBits[i]=Num2Bits(WD); wBits[i].in <== winIdx[i];
  wTree[i]=MerkleRoot(WD); wTree[i].leaf <== root[i];
  for(var j=0;j<WD;j++) { wTree[i].bits[j] <== wBits[i].out[j]; wTree[i].siblings[j] <== winPath[i][j]; }
  wTree[i].root === winRoot;

  for(var k=0;k<M;k++) {
   var s=i*M+k;
   ins[s]=IndexedInsert(D, NF_TAG); ins[s].nf <== nf[i][k]; ins[s].count <== nfCount+s; ins[s].oldRoot <== nfRoots[s];
   ins[s].predIdx <== predIdx[s];
   for(var j=0;j<3;j++) ins[s].pred[j] <== pred[s][j];
   for(var j=0;j<D;j++) { ins[s].predPath[j] <== predPath[s][j]; ins[s].appendPath[j] <== appendPath[s][j]; }
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
 append.noteRoot <== noteRoot; append.noteSlot <== noteSlot;
 for(var i=0;i<D-SUB;i++) append.slotPath[i] <== slotPath[i];
 noteCount === noteSlot*(1<<SUB);

 component kBits=Num2Bits(WD); kBits.in <== batchCount-batchQ*(1<<WD);
 component qBits=Num2Bits(26); qBits.in <== batchQ;
 component wOld=MerkleRoot(WD); component wNew=MerkleRoot(WD);
 wOld.leaf <== winOldLeaf; wNew.leaf <== append.newRoot;
 for(var j=0;j<WD;j++) {
  wOld.bits[j] <== kBits.out[j]; wNew.bits[j] <== kBits.out[j];
  wOld.siblings[j] <== winSlotPath[j]; wNew.siblings[j] <== winSlotPath[j];
 }
 wOld.root === winRoot;

 component oldState=Poseidon(9); component newState=Poseidon(9);
 oldState.inputs[0] <== STATE_TAG; oldState.inputs[1] <== noteRoot; oldState.inputs[2] <== noteCount;
 oldState.inputs[3] <== nfRoot; oldState.inputs[4] <== nfCount; oldState.inputs[5] <== winRoot;
 oldState.inputs[6] <== batchCount; oldState.inputs[7] <== 0; oldState.inputs[8] <== 0;
 newState.inputs[0] <== STATE_TAG; newState.inputs[1] <== append.newRoot; newState.inputs[2] <== noteCount+(1<<SUB);
 newState.inputs[3] <== nfRoots[N*M]; newState.inputs[4] <== nfCount+N*M; newState.inputs[5] <== wNew.root;
 newState.inputs[6] <== batchCount+1; newState.inputs[7] <== 0; newState.inputs[8] <== 0;

 component bind=Binding(KIND, N);
 bind.fields[0] <== oldState.out; bind.fields[1] <== newState.out; bind.fields[2] <== daChain[N];
 bind.statement === statement;
}
