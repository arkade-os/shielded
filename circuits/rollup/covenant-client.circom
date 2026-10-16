pragma circom 2.2.2;
// Covenant test fixture: the client public layout with no relation behind it.
// Every public signal sits in a product so no verification-key point is zero.
template CovenantClient() {
    signal input pub;
    signal input nf0;
    signal input nf1;
    signal input deposit;
    signal input withdraw;
    signal input boundaryAsset;
    signal input destination;
    signal input w;
    pub === w * w;
    signal square[6];
    square[0] <== deposit * deposit;
    square[1] <== withdraw * withdraw;
    square[2] <== boundaryAsset * boundaryAsset;
    square[3] <== destination * destination;
    square[4] <== nf0 * nf0;
    square[5] <== nf1 * nf1;
}
component main {public [pub, nf0, nf1, deposit, withdraw, boundaryAsset, destination]} = CovenantClient();
