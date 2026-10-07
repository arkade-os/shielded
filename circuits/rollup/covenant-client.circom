pragma circom 2.2.2;
// Covenant test fixture: the client public layout with no relation behind it.
// Every public signal sits in a product so no verification-key point is zero.
template CovenantClient() {
    signal input pub;
    signal input deposit;
    signal input withdraw;
    signal input boundaryAsset;
    signal input destination;
    signal input w;
    pub === w * w;
    signal square[4];
    square[0] <== deposit * deposit;
    square[1] <== withdraw * withdraw;
    square[2] <== boundaryAsset * boundaryAsset;
    square[3] <== destination * destination;
}
component main {public [pub, deposit, withdraw, boundaryAsset, destination]} = CovenantClient();
