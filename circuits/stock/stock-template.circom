pragma circom 2.1.6;
include "common.circom";
include "circomlib/circuits/sha256/sha256.circom";
template StockWord64() {
 signal input bytes[8]; signal output value;
 var acc=0; var factor=1;
 component bits[8];
 for(var i=0;i<8;i++) { bits[i]=Num2Bits(8); bits[i].in <== bytes[i]; acc += bytes[i]*factor; factor *= 256; }
 value <== acc;
}
template StockCombined() {
 signal input native[201];
 signal output statement;
 signal input intentData[25];
 signal input inputAmount; signal input inputAsset; signal input inputRho; signal input spendSecret;
 signal input inputCipher[7]; signal input inputPath[8]; signal input inputBits[8];
 signal input outputAmount[2]; signal input outputAsset[2]; signal input outputOwner[2]; signal input outputRandom[2];
 signal input recipient[2][2]; signal input recipientPreimage[2][2]; signal input ephemeral[2];
 signal input transitionData[30]; signal input appendPaths[2][8];
 signal input historyPath[8]; signal input historyIndex; signal input sealPath[8];
 signal input nfCount; signal input nfPredecessorIndex; signal input nfPredecessor[3];
 signal input nfPredecessorPath[9]; signal input nfAppendPath[9]; signal input lastSealedRoot; signal input lastSealPath[8];
 signal input oldState[8]; signal input newState[8];

 component nativeByte[201];
 for(var i=0;i<201;i++) { nativeByte[i]=Num2Bits(8); nativeByte[i].in <== native[i]; }
 native[0] === 83; native[1] === 72; native[2] === 1; native[3] === 0;
 component modeBits=Num2Bits(2); modeBits.in <== native[4];
 signal mode; mode <== native[4];
 component nativeHash=Sha256(201*8);
 for(var i=0;i<201;i++) for(var b=0;b<8;b++) nativeHash.in[i*8+b] <== nativeByte[i].out[7-b];
 var statementValue=0;
 for(var i=0;i<31;i++) for(var b=0;b<8;b++) statementValue += nativeHash.out[i*8+b]*(2**(8*i+7-b));
 statement <== statementValue;
 var emptyHash[32] = [227,176,196,66,152,252,28,20,154,251,244,200,153,111,185,36,39,174,65,228,100,155,147,76,164,149,153,27,120,82,184,85];
 for(var i=0;i<32;i++) native[169+i] === emptyHash[i];

 component oldStateHash=Poseidon(9); component newStateHash=Poseidon(9);
 oldStateHash.inputs[0] <== 20260930001; newStateHash.inputs[0] <== 20260930001;
 for(var i=0;i<8;i++) { oldStateHash.inputs[i+1] <== oldState[i]; newStateHash.inputs[i+1] <== newState[i]; }
 component oldStateBits=Num2Bits_strict(); component newStateBits=Num2Bits_strict();
 oldStateBits.in <== oldStateHash.out; newStateBits.in <== newStateHash.out;
 for(var i=0;i<32;i++) for(var b=0;b<8;b++) {
  if(i*8+b<254) { nativeByte[41+i].out[b] === oldStateBits.out[i*8+b]; nativeByte[73+i].out[b] === newStateBits.out[i*8+b]; }
  else { nativeByte[41+i].out[b] === 0; nativeByte[73+i].out[b] === 0; }
 }

 component oldNoteCount=Num2Bits(9); component newNoteCount=Num2Bits(9);
 component oldHistoryCount=Num2Bits(9); component newHistoryCount=Num2Bits(9);
 component oldRevision=Num2Bits(10); component newRevision=Num2Bits(10);
 component oldReserve=Num2Bits(48); component newReserve=Num2Bits(48);
 oldNoteCount.in <== oldState[3]; newNoteCount.in <== newState[3];
 oldHistoryCount.in <== oldState[4]; newHistoryCount.in <== newState[4];
 oldRevision.in <== oldState[5]; newRevision.in <== newState[5];
 oldReserve.in <== oldState[6]; newReserve.in <== newState[6];
 oldState[7] === 0; newState[7] === 0;
 newState[5] === oldState[5]+1;
 component oldNoteBound=LessEqThan(9); oldNoteBound.in[0] <== oldState[3]; oldNoteBound.in[1] <== 256; oldNoteBound.out === 1;
 component newNoteBound=LessEqThan(9); newNoteBound.in[0] <== newState[3]; newNoteBound.in[1] <== 256; newNoteBound.out === 1;
 component oldHistoryBound=LessEqThan(9); oldHistoryBound.in[0] <== oldState[4]; oldHistoryBound.in[1] <== 256; oldHistoryBound.out === 1;
 component newHistoryBound=LessEqThan(9); newHistoryBound.in[0] <== newState[4]; newHistoryBound.in[1] <== 256; newHistoryBound.out === 1;

 component poolIn=StockWord64(); component poolOut=StockWord64(); component fundingIn=StockWord64(); component externalOut=StockWord64();
 for(var i=0;i<8;i++) {
  poolIn.bytes[i] <== native[105+i]; poolOut.bytes[i] <== native[113+i];
  fundingIn.bytes[i] <== native[121+i]; externalOut.bytes[i] <== native[129+i];
 }
 poolIn.value === 330+oldState[6]; poolOut.value === 330+newState[6];
 poolIn.value+fundingIn.value === poolOut.value+externalOut.value;

 component assetBtc=Num2Bits(1); assetBtc.in <== inputAsset; assetBtc.out[0] === 0;
 component outAsset[2]; for(var i=0;i<2;i++) { outAsset[i]=Num2Bits(1); outAsset[i].in <== outputAsset[i]; outAsset[i].out[0] === 0; }
 intentData[0] === 20260930001; intentData[20] === 0; intentData[22] === 0;
 signal modeTransfer; signal modeDeposit; signal modeWithdraw; signal modeSeal;
 component z0=IsZero(); z0.in <== mode; modeTransfer <== z0.out;
 component z1=IsZero(); z1.in <== mode-1; modeDeposit <== z1.out;
 component z2=IsZero(); z2.in <== mode-2; modeWithdraw <== z2.out;
 component z3=IsZero(); z3.in <== mode-3; modeSeal <== z3.out;
 modeTransfer+modeDeposit+modeWithdraw+modeSeal === 1;
 for(var i=0;i<32;i++) {
  (modeTransfer+modeSeal)*native[137+i] === 0;

 }
 (modeTransfer+modeSeal)*fundingIn.value === 0;
 (modeTransfer+modeSeal)*externalOut.value === 0;
 (modeTransfer+modeSeal)*intentData[19] === 0;
 (modeTransfer+modeDeposit)*intentData[21] === 0;
 (modeTransfer+modeWithdraw+modeSeal)*intentData[19] === 0;
 (modeTransfer+modeDeposit+modeSeal)*intentData[23] === 0;
 modeDeposit*(fundingIn.value-externalOut.value-intentData[19]) === 0;
 component positiveFunding=IsZero(); positiveFunding.in <== fundingIn.value; modeDeposit*positiveFunding.out === 0;
 component positiveDeposit=IsZero(); positiveDeposit.in <== intentData[19]; modeDeposit*positiveDeposit.out === 0;

 modeWithdraw*(externalOut.value-intentData[21]-fundingIn.value) === 0;
 component positivePayout=IsZero(); positivePayout.in <== externalOut.value; modeWithdraw*positivePayout.out === 0;
 component positiveWithdrawal=IsZero(); positiveWithdrawal.in <== intentData[21]; modeWithdraw*positiveWithdrawal.out === 0;
 signal extProgramBits[256];
 for(var i=0;i<32;i++) for(var b=0;b<8;b++) extProgramBits[i*8+b] <== nativeByte[137+i].out[7-b];
 component destinationHash=Sha256(256);
 for(var i=0;i<256;i++) destinationHash.in[i] <== extProgramBits[i];
 var destinationValue=0;
 for(var i=0;i<32;i++) for(var b=0;b<8;b++) destinationValue += destinationHash.out[i*8+b]*(2**(8*i+7-b));
 modeWithdraw*(intentData[23]-destinationValue) === 0;
 component noChange=IsZero(); noChange.in <== externalOut.value;
 signal depositNoChange; depositNoChange <== modeDeposit*noChange.out;
 for(var i=0;i<32;i++) depositNoChange*native[137+i] === 0;
 modeDeposit*inputAmount === 0;
 modeSeal*inputAmount === 0;
 for(var i=0;i<2;i++) modeSeal*outputAmount[i] === 0;
 component intent=Intent();
 for(var i=0;i<25;i++) intent.data[i] <== intentData[i];
 intent.inputAmount <== inputAmount; intent.inputAsset <== inputAsset; intent.inputRho <== inputRho; intent.spendSecret <== spendSecret;
 for(var i=0;i<7;i++) intent.inputCipher[i] <== inputCipher[i];
 for(var i=0;i<8;i++) { intent.inputPath[i] <== inputPath[i]; intent.inputBits[i] <== inputBits[i]; }
 for(var i=0;i<2;i++) {
  intent.outputAmount[i] <== outputAmount[i]; intent.outputAsset[i] <== outputAsset[i];
  intent.outputOwner[i] <== outputOwner[i]; intent.outputRandom[i] <== outputRandom[i]; intent.ephemeral[i] <== ephemeral[i];
  for(var j=0;j<2;j++) { intent.recipient[i][j] <== recipient[i][j]; intent.recipientPreimage[i][j] <== recipientPreimage[i][j]; }
 }
 component transition=StockTransition();
 for(var i=0;i<30;i++) transition.data[i] <== transitionData[i];
 for(var i=0;i<2;i++) { transition.outputAmount[i] <== outputAmount[i]; for(var j=0;j<8;j++) transition.appendPaths[i][j] <== appendPaths[i][j]; }
 transition.modeWithdraw <== modeWithdraw;
 for(var i=0;i<8;i++) { transition.historyPath[i] <== historyPath[i]; transition.sealPath[i] <== sealPath[i]; transition.lastSealPath[i] <== lastSealPath[i]; }
 transition.historyIndex <== historyIndex; transition.lastSealedRoot <== lastSealedRoot;
 transition.nfCount <== nfCount; transition.nfPredecessorIndex <== nfPredecessorIndex;
 for(var i=0;i<3;i++) transition.nfPredecessor[i] <== nfPredecessor[i];
 for(var i=0;i<9;i++) { transition.nfPredecessorPath[i] <== nfPredecessorPath[i]; transition.nfAppendPath[i] <== nfAppendPath[i]; }
 transitionData[0] === 20260930001;
 transitionData[19] === modeSeal;
 transitionData[20] === oldState[0]; transitionData[21] === newState[0];
 transitionData[22] === oldState[1]; transitionData[23] === newState[1];
 transitionData[24] === oldState[2]; transitionData[25] === newState[2];
 transitionData[26] === oldState[3]; transitionData[27] === newState[3];
 transitionData[28] === oldState[4]; transitionData[29] === newState[4];
 for(var i=0;i<19;i++) {
  if(i==0) intentData[i] === 20260930001;
  else {
   (1-modeSeal)*(transitionData[i]-intentData[i]) === 0;
   modeSeal*transitionData[i] === 0;
  }
 }
 intentData[19] === (1-modeSeal)*intentData[19];
 intentData[21] === (1-modeSeal)*intentData[21];
 newState[6]-oldState[6] === intentData[19]-intentData[21];
}
component main = StockCombined();
